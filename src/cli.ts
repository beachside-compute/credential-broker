#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- Validate JSON objects read from stdin. */
import { parseArgs } from "node:util";
import { outro } from "@clack/prompts";
import {
  createCredentialBrokerAdmin,
  type BrokerIntegrationCredential,
  type BrokerIntegrationKind,
  type BrokerIntegrationInput,
} from "./admin.js";
import { normalizeEndpoint, normalizeEndpointValues } from "./endpoint.js";
import { setupIntegration } from "./setup.js";
import { CredentialBrokerError, integrationName } from "./transport.js";

const help = `Manage runtime integrations and grant issuance for a Beachside credential broker.

Set BEACHSIDE_BROKER_URL to the broker HTTPS origin and BEACHSIDE_BROKER_ADMIN_KEY to its admin key.

Commands
  beachside-broker integration setup [--json]
  beachside-broker integration list
  beachside-broker integration show <id>
  beachside-broker integration create <id> --provider <github|anthropic|openai|openrouter> (--secret-stdin | --worker-secret <binding>)
  beachside-broker integration create <id> --provider http --config-stdin
  beachside-broker integration rotate <id> (--secret-stdin | --worker-secret <binding> | --credentials-stdin)
  beachside-broker integration disable <id>
  beachside-broker integration enable <id>
  beachside-broker integration delete <id>
  beachside-broker issuer show
  beachside-broker issuer set [integration-id...]

Issuer set replaces the grant issuance allowlist. Omit integration IDs to clear it.
Pipe one credential value to --secret-stdin, optionally followed by a newline.
For HTTP integrations, --config-stdin takes JSON with endpoint and credential fields.
--credentials-stdin takes a JSON map of header names to replacement secrets.
Interactive setup prints a confirmation. Add --json to write its metadata to stdout.
Other commands print JSON metadata.`;

function usageError(message: string): never {
  throw new CredentialBrokerError("INVALID_ARGUMENT", message);
}

async function readStdin(limit: number, error: string) {
  if (process.stdin.isTTY) usageError("Pipe the input to stdin");
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const data of process.stdin) {
    if (!(data instanceof Uint8Array)) usageError("Expected input on stdin");
    total += data.byteLength;

    if (total > limit) usageError(error);
    chunks.push(data);
  }

  return Buffer.concat(chunks);
}

async function readSecret() {
  const buffer = await readStdin(4098, "Credential on stdin exceeds 4096 bytes");
  const newline = buffer.at(-1) === 0x0a;
  const suffixBytes = newline ? (buffer.at(-2) === 0x0d ? 2 : 1) : 0;
  const length = buffer.byteLength - suffixBytes;

  if (!length) usageError("Expected an upstream credential on stdin");

  if (length > 4096) usageError("Credential on stdin exceeds 4096 bytes");

  return buffer.toString("utf8", 0, length);
}

async function credentialFromFlags(flags: {
  "secret-stdin"?: boolean;
  "worker-secret"?: string;
}): Promise<BrokerIntegrationCredential> {
  const binding = flags["worker-secret"];
  const stdin = flags["secret-stdin"];

  if (stdin && binding === undefined)
    return { source: "encrypted-store", value: await readSecret() };

  if (!stdin && binding) return { source: "worker-secret", binding };

  return usageError("Select exactly one credential source with --secret-stdin or --worker-secret");
}

function provider(value: string | undefined): Exclude<BrokerIntegrationKind, "http"> {
  switch (value) {
    case "github":
    case "anthropic":
    case "openai":
    case "openrouter":
      return value;
    default:
      return usageError("Choose a supported integration kind with --provider");
  }
}

function integrationId(positionals: string[]): string {
  if (positionals.length !== 1 || !positionals[0])
    return usageError("Pass exactly one integration ID");

  if (!integrationName.test(positionals[0]))
    return usageError("Invalid broker integration identifier");

  return positionals[0];
}

function noPositionals(positionals: string[]): void {
  if (positionals.length) usageError("This command takes no arguments");
}

async function main(args: string[]) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(help);

    return;
  }

  const [group, command, ...options] = args;
  const creates = group === "integration" && command === "create";
  const setup = group === "integration" && command === "setup";
  const usesCredential = creates || (group === "integration" && command === "rotate");

  if (group !== "integration" && group !== "issuer")
    return usageError("Choose a command group with integration or issuer");

  const { values, positionals } = parseCommandOptions(options);

  const rotates = group === "integration" && command === "rotate";

  if (!setup && values.json) return usageError("--json is only accepted by integration setup");

  if (!creates && values["config-stdin"])
    return usageError("--config-stdin is only accepted by integration create");

  if (!rotates && values["credentials-stdin"])
    return usageError("--credentials-stdin is only accepted by integration rotate");

  if (!creates && values.provider !== undefined)
    return usageError("--provider is only accepted by integration create");

  if (!usesCredential && (values["secret-stdin"] || values["worker-secret"] !== undefined))
    return usageError("Credential options are only accepted by integration create and rotate");

  const url = process.env.BEACHSIDE_BROKER_URL;
  const apiKey = process.env.BEACHSIDE_BROKER_ADMIN_KEY;

  if (!url || !apiKey) return usageError("Set BEACHSIDE_BROKER_URL and BEACHSIDE_BROKER_ADMIN_KEY");
  const admin = createCredentialBrokerAdmin({ url, apiKey });

  const output =
    group === "integration"
      ? await integrationCommand(command, positionals, values, admin)
      : await issuerCommand(command, positionals, admin);

  if (output !== undefined) console.log(JSON.stringify(output));
}

function parseCommandOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        provider: { type: "string" },
        json: { type: "boolean" },
        "secret-stdin": { type: "boolean" },
        "worker-secret": { type: "string" },
        "config-stdin": { type: "boolean" },
        "credentials-stdin": { type: "boolean" },
      },
    });
  } catch {
    // The parser may include caller-supplied option names or values in its error.
    return usageError("Invalid command options. See beachside-broker --help");
  }
}

async function readJsonStdin(): Promise<object> {
  const bytes = await readStdin(96_000, "JSON input on stdin exceeds 96000 bytes");

  try {
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

    if (input && typeof input === "object" && !Array.isArray(input)) return input;
  } catch {
    // Never echo parser errors because they may contain the credential input.
  }

  return usageError("Expected a JSON object on stdin");
}

async function endpointFromStdin(id: string): Promise<BrokerIntegrationInput> {
  const input = await readJsonStdin();

  if (!("endpoint" in input && "credential" in input))
    return usageError("Expected endpoint and credential JSON fields");
  const endpoint = normalizeEndpoint(input.endpoint);
  const credential = input.credential;

  const values =
    credential !== null &&
    typeof credential === "object" &&
    "source" in credential &&
    credential.source === "encrypted-store" &&
    "values" in credential &&
    normalizeEndpointValues(credential.values);

  if (!endpoint || !values) return usageError("Invalid broker endpoint configuration");

  return { id, kind: "http", endpoint, credential: { source: "encrypted-store", values } };
}

type Admin = ReturnType<typeof createCredentialBrokerAdmin>;

async function integrationCommand(
  command: string | undefined,
  positionals: string[],
  values: ReturnType<typeof parseCommandOptions>["values"],
  { integrations }: Admin,
) {
  switch (command) {
    case "setup": {
      noPositionals(positionals);
      const config = await setupIntegration();
      const created = await integrations.create(config);

      if (values.json) return created;

      outro(`Created integration ${created.id}.`, { output: process.stderr });
      console.error(
        `Allow your issuer to create temporary grants for this integration.\nRun issuer show using the same CLI prefix.\nThen run issuer set with your existing IDs plus ${created.id}.`,
      );

      return;
    }

    case "list":
      noPositionals(positionals);

      return { integrations: await integrations.list() };
    case "show":
      return integrations.get(integrationId(positionals));
    case "create": {
      const id = integrationId(positionals);

      if (values.provider === "http") {
        if (
          !values["config-stdin"] ||
          values["secret-stdin"] ||
          values["worker-secret"] !== undefined
        )
          return usageError("HTTP integration creation requires only --config-stdin");

        return integrations.create(await endpointFromStdin(id));
      }

      if (values["config-stdin"]) return usageError("--config-stdin requires --provider http");

      return integrations.create({
        id,
        kind: provider(values.provider),
        credential: await credentialFromFlags(values),
      });
    }

    case "rotate": {
      const id = integrationId(positionals);

      if (!values["credentials-stdin"])
        return integrations.rotate(id, await credentialFromFlags(values));

      if (values["secret-stdin"] || values["worker-secret"] !== undefined)
        return usageError("Select exactly one credential source when rotating");
      const replacements = normalizeEndpointValues(await readJsonStdin());

      if (!replacements) return usageError("Expected replacement header secrets on stdin");

      return integrations.rotate(id, { source: "encrypted-store", values: replacements });
    }

    case "enable":
    case "disable":
      return integrations.setEnabled(integrationId(positionals), command === "enable");
    case "delete":
      await integrations.delete(integrationId(positionals));

      return { deleted: true };
    default:
      return usageError("Choose an integration command. See beachside-broker --help");
  }
}

async function issuerCommand(
  command: string | undefined,
  positionals: string[],
  { issuerPermissions }: Admin,
) {
  switch (command) {
    case "show":
      noPositionals(positionals);

      return issuerPermissions.get();
    case "set":
      return issuerPermissions.set(positionals);
    default:
      return usageError("Choose an issuer command. See beachside-broker --help");
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message =
    error instanceof CredentialBrokerError
      ? `${error.code} ${error.message}`
      : "Invalid command or unreadable input. See beachside-broker --help";

  console.error(message);
  process.exitCode = 1;
}
