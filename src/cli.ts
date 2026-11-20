#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  createCredentialBrokerAdmin,
  type BrokerIntegrationCredential,
  type BrokerIntegrationKind,
} from "./admin.js";
import { CredentialBrokerError, integrationName } from "./transport.js";

const help = `Manage runtime integrations and grant issuance for a Beachside credential broker.

Set BEACHSIDE_BROKER_URL to the broker HTTPS origin and BEACHSIDE_BROKER_ADMIN_KEY to its admin key.

Commands
  beachside-broker integration list
  beachside-broker integration show <id>
  beachside-broker integration create <id> --provider <github|anthropic|openai|openrouter> (--secret-stdin | --worker-secret <binding>)
  beachside-broker integration rotate <id> (--secret-stdin | --worker-secret <binding>)
  beachside-broker integration disable <id>
  beachside-broker integration enable <id>
  beachside-broker integration delete <id>
  beachside-broker issuer show
  beachside-broker issuer set [integration-id...]

Issuer set replaces the grant issuance allowlist. Omit integration IDs to clear it.
Pipe one credential value to --secret-stdin, optionally followed by a newline.
Successful commands print JSON metadata.`;

function usageError(message: string): never {
  throw new CredentialBrokerError("INVALID_ARGUMENT", message);
}

async function readSecret() {
  if (process.stdin.isTTY) usageError("Pipe a credential value to --secret-stdin");
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const data of process.stdin) {
    if (!(data instanceof Uint8Array)) usageError("Expected an upstream credential on stdin");
    total += data.byteLength;

    if (total > 4098) usageError("Credential on stdin exceeds 4096 bytes");
    chunks.push(data);
  }

  const buffer = Buffer.concat(chunks);
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

function provider(value: string | undefined): BrokerIntegrationKind {
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
  const usesCredential = creates || (group === "integration" && command === "rotate");

  if (group !== "integration" && group !== "issuer")
    return usageError("Choose a command group with integration or issuer");

  const { values, positionals } = parseCommandOptions(options);

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

  console.log(JSON.stringify(output));
}

function parseCommandOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        provider: { type: "string" },
        "secret-stdin": { type: "boolean" },
        "worker-secret": { type: "string" },
      },
    });
  } catch {
    // The parser may include caller-supplied option names or values in its error.
    return usageError("Invalid command options. See beachside-broker --help");
  }
}

type Admin = ReturnType<typeof createCredentialBrokerAdmin>;

async function integrationCommand(
  command: string | undefined,
  positionals: string[],
  values: { provider?: string; "secret-stdin"?: boolean; "worker-secret"?: string },
  { integrations }: Admin,
) {
  switch (command) {
    case "list":
      noPositionals(positionals);

      return { integrations: await integrations.list() };
    case "show":
      return integrations.get(integrationId(positionals));
    case "create":
      return integrations.create({
        id: integrationId(positionals),
        kind: provider(values.provider),
        credential: await credentialFromFlags(values),
      });
    case "rotate":
      return integrations.rotate(integrationId(positionals), await credentialFromFlags(values));
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
