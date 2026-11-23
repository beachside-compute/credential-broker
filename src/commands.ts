/* oxlint-disable anti-slop/no-runtime-typeof -- Validate JSON objects read from stdin. */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { outro } from "@clack/prompts";
import {
  createCredentialBrokerAdmin,
  type BrokerIntegration,
  type BrokerIntegrationCredential,
  type BrokerIntegrationKind,
  type BrokerIntegrationInput,
  type BrokerWorkflowPolicy,
} from "./admin.js";
import { normalizeEndpoint, normalizeEndpointValues } from "./endpoint.js";
import { resolveSecret } from "./secret-ref.js";
import type { BrokerGrantSummary } from "./grants.js";
import { createCredentialBroker, integrationBaseURL } from "./index.js";
import { setupIntegration } from "./setup.js";
import {
  brokerOrigin,
  CredentialBrokerError,
  hint,
  integrationName,
  maxGrantTtlSeconds,
  setHintPrefix,
} from "./transport.js";

/** Where an embedding program sends output and reads settings. */
export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The command prefix in help and hints, such as `beachside broker`. */
  readonly prefix?: string;
  /** Asks for a key no setting supplies, when a person is at the terminal. */
  readonly promptKey?: (role: "admin" | "issuer") => Promise<string | undefined>;
}

/** Exit codes shared with the `beachside` CLI. */
const exitCodes: Readonly<Record<CredentialBrokerError["code"], number>> = {
  INVALID_ARGUMENT: 2,
  NOT_FOUND: 3,
  UNAUTHENTICATED: 5,
  FORBIDDEN: 5,
  CONFLICT: 1,
  INVALID_RESPONSE: 1,
  RATE_LIMIT: 7,
  UNAVAILABLE: 7,
  TIMEOUT: 6,
  WAIT_ABORTED: 6,
};

function helpText(prefix: string) {
  return `Manage a Beachside credential broker: its integrations, who may issue grants, and the grants themselves.

Usage: ${prefix} <command> [options]

Broker
  status                                   Check the URL and key: role, limits and counts
  config show                              Show the GitHub Actions trust policy (admin)

Integrations (admin key)
  integration setup [--no-allow-issue]     Add an integration with a guided prompt
  integration list
  integration show <id>
  integration create <id> --provider <github|anthropic|openai|openrouter> (--secret-stdin | --worker-secret <binding>) [--allow-issue]
  integration create <id> --provider http --config-stdin [--allow-issue]
  integration rotate <id> (--secret-stdin | --worker-secret <binding> | --credentials-stdin)
  integration enable <id> | disable <id> | delete <id>

Issuance allowlist (admin key)
  issuer show
  issuer allow <id...>                     Let the issuer mint grants for these integrations
  issuer deny <id...>                      Stop new grants for them (existing grants keep working)
  issuer set [id...]                       Replace the whole list

Grants (issuer key; --all uses the admin key)
  grant issue <id...> [--ttl <duration>] [--label <text>] [--token]
  grant list [--all]
  grant renew <grant-id> [--ttl <duration>]
  grant revoke <grant-id>

Options
  --url <origin>   Broker origin: HTTPS, or HTTP to localhost (default BEACHSIDE_BROKER_URL)
  --json           Print JSON instead of text
  --version        Print the client version

Keys come from BEACHSIDE_BROKER_ADMIN_KEY and BEACHSIDE_BROKER_ISSUER_KEY, as values or
env:NAME, op://, bws:// or pass:// references.
Durations are seconds or a number with s, m, h or d, from 1s to 7d. Grants default to 15m.
Pipe one credential to --secret-stdin. --config-stdin takes {"endpoint", "credential"} JSON,
--credentials-stdin a JSON map of header names to replacement secrets.
Exit codes: 0 ok, 1 other, 2 usage, 3 not found, 5 authentication or permission, 6 outcome unknown, 7 retryable.`;
}

function usageError(message: string): never {
  throw new CredentialBrokerError("INVALID_ARGUMENT", message);
}

/** Seconds, or a count with an `s`, `m`, `h` or `d` unit, up to seven days. */
export function parseDuration(value: string): number {
  const match = /^([0-9]{1,7})([smhd]?)$/.exec(value.trim());
  const scale = { "": 1, s: 1, m: 60, h: 3_600, d: 86_400 } as const;
  const unit = match?.[2];

  const seconds =
    match && (unit === "" || unit === "s" || unit === "m" || unit === "h" || unit === "d")
      ? Number(match[1]) * scale[unit]
      : NaN;

  if (!(seconds >= 1 && seconds <= maxGrantTtlSeconds))
    return usageError("--ttl must be 1s to 7d, for example 900, 15m, 12h or 7d");

  return seconds;
}

/** A short human form of a lifetime, such as `7d` or `15m`. */
export function formatDuration(seconds: number): string {
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ] as const) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
  }

  return `${seconds}s`;
}

function until(iso: string, now = Date.now()): string {
  const left = Math.round((Date.parse(iso) - now) / 1_000);

  if (left <= 0) return "expired";

  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);

  if (days) return `in ${days}d${hours ? ` ${hours}h` : ""}`;

  if (hours) return `in ${hours}h${minutes ? ` ${minutes}m` : ""}`;

  return minutes ? `in ${minutes}m` : `in ${left}s`;
}

function since(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const elapsed = Math.max(0, Math.round((now - Date.parse(iso)) / 1_000));

  if (elapsed >= 86_400) return `${Math.floor(elapsed / 86_400)}d ago`;

  if (elapsed >= 3_600) return `${Math.floor(elapsed / 3_600)}h ago`;

  return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ago` : `${elapsed}s ago`;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));

  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  "),
    )
    .join("\n");
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
      return usageError("Choose --provider github, anthropic, openai, openrouter or http");
  }
}

function integrationIds(positionals: string[], many: boolean): string[] {
  if (!positionals.length || (!many && positionals.length !== 1))
    return usageError(
      many ? "Pass one or more integration IDs" : "Pass exactly one integration ID",
    );

  for (const id of positionals) {
    if (!integrationName.test(id))
      usageError(
        `Invalid integration ID ${JSON.stringify(id).slice(0, 40)}. Use 1 to 32 lowercase letters, digits or hyphens, starting with a letter`,
      );
  }

  return positionals;
}

function noPositionals(positionals: string[]): void {
  if (positionals.length) usageError("This command takes no arguments");
}

function parseCommandOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        provider: { type: "string" },
        ttl: { type: "string" },
        label: { type: "string" },
        token: { type: "boolean" },
        all: { type: "boolean" },
        "allow-issue": { type: "boolean" },
        "no-allow-issue": { type: "boolean" },
        "secret-stdin": { type: "boolean" },
        "worker-secret": { type: "string" },
        "config-stdin": { type: "boolean" },
        "credentials-stdin": { type: "boolean" },
      },
    });
  } catch {
    // The parser may include caller-supplied option names or values in its error.
    return usageError("Invalid command options. See --help");
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

/** Which flags each command takes, so a stray flag is a usage error rather than ignored. */
const allowedFlags = {
  status: [],
  "config show": [],
  "integration setup": ["no-allow-issue"],
  "integration list": [],
  "integration show": [],
  "integration create": [
    "provider",
    "secret-stdin",
    "worker-secret",
    "config-stdin",
    "allow-issue",
  ],
  "integration rotate": ["secret-stdin", "worker-secret", "credentials-stdin"],
  "integration enable": [],
  "integration disable": [],
  "integration delete": [],
  "issuer show": [],
  "issuer allow": [],
  "issuer deny": [],
  "issuer set": [],
  "grant issue": ["ttl", "label", "token"],
  "grant list": ["all"],
  "grant renew": ["ttl"],
  "grant revoke": [],
} satisfies Readonly<Record<string, readonly string[]>>;

const globalFlags = new Set(["url", "json", "help", "version"]);

function flagsFor(command: string): readonly string[] | undefined {
  for (const [name, flags] of Object.entries(allowedFlags)) if (name === command) return flags;
}

function clientVersion(env: CliIo["env"]): string {
  // The checkout runner bundles this file away from its manifest and passes the version instead.
  if (env.BEACHSIDE_BROKER_CLI_VERSION) return env.BEACHSIDE_BROKER_CLI_VERSION;

  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    if (manifest && typeof manifest === "object" && "version" in manifest)
      return String(manifest.version);
  } catch {
    // A bundled copy has no manifest next to it.
  }

  return "unknown";
}

function integrationLines(items: readonly BrokerIntegration[]): string {
  if (!items.length) return `No integrations yet. Add one with \`${hint("integration setup")}\`.`;

  return table([
    ["ID", "KIND", "STATE", "GRANTS", "UPSTREAM", "VERSION"],
    ...items.map((item) => [
      item.id,
      item.kind,
      item.enabled ? "enabled" : "disabled",
      item.issuable === undefined ? "?" : item.issuable ? "allowed" : "not allowed",
      item.endpoint?.baseURL ?? builtInUpstream(item.kind),
      `v${item.credentialVersion}`,
    ]),
  ]);
}

function builtInUpstream(kind: BrokerIntegrationKind): string {
  switch (kind) {
    case "github":
      return "https://github.com";
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com";
    case "openrouter":
      return "https://openrouter.ai";
    case "http":
      return "";
  }
}

function integrationDetail(item: BrokerIntegration): string {
  const lines = [
    `${item.id} (${item.kind})`,
    `  state       ${item.enabled ? "enabled" : "disabled"}`,
    `  grants      ${item.issuable === undefined ? "unknown" : item.issuable ? "allowed" : `not allowed; run \`${hint(`issuer allow ${item.id}`)}\``}`,
    `  upstream    ${item.endpoint?.baseURL ?? builtInUpstream(item.kind)}`,
    `  credential  ${item.credentialSource}, version ${item.credentialVersion}`,
    `  updated     ${item.updatedAt}`,
  ];

  for (const header of item.endpoint?.headers ?? [])
    lines.push(
      `  header      ${header.name}: ${"secret" in header && header.secret ? `${header.prefix ?? ""}<secret>` : "value" in header ? header.value : ""}`,
    );

  return lines.join("\n");
}

function grantLines(grants: readonly BrokerGrantSummary[], withOwner: boolean): string {
  if (!grants.length) return "No active grants.";

  return table([
    [
      "ID",
      "INTEGRATIONS",
      "LABEL",
      "EXPIRES",
      "REQUESTS",
      "LAST USED",
      ...(withOwner ? ["ISSUER"] : []),
    ],
    ...grants.map((grant) => [
      grant.id,
      grant.integrations.join(",") || "-",
      grant.label ?? "-",
      until(grant.expiresAt),
      String(grant.requests),
      since(grant.lastUsedAt),
      ...(withOwner ? [grant.owner ?? "-"] : []),
    ]),
  ]);
}

function policyText(value: BrokerWorkflowPolicy[string]): string {
  if (typeof value === "string" && value) return value;

  if (Array.isArray(value) && value.length) return value.join(", ");

  return "-";
}

/**
 * A broker that reports kinds must report one for every integration in the grant. Only a broker
 * that reports none (before API v2) falls back to generic HTTP.
 */
function grantKind(
  kinds: Readonly<Record<string, BrokerIntegrationKind>> | undefined,
  id: string,
): BrokerIntegrationKind {
  if (!kinds) return "http";
  const kind = kinds[id];

  if (!kind)
    throw new CredentialBrokerError(
      "INVALID_RESPONSE",
      `Credential broker did not report the kind of ${id}`,
    );

  return kind;
}

/** Allow a just-created integration, saying how to finish if that second step fails. */
async function allowCreated(
  admin: ReturnType<typeof createCredentialBrokerAdmin>,
  id: string,
): Promise<{ integrations: string[] }> {
  try {
    return await admin.issuerPermissions.allow(id);
  } catch (error) {
    if (!(error instanceof CredentialBrokerError)) throw error;

    throw new CredentialBrokerError(
      error.code,
      `Created integration ${id}, but could not allow grants for it: ${error.message}. Finish with \`${hint(`issuer allow ${id}`)}\``,
    );
  }
}

/**
 * Run one broker command. Returns the exit code; never exits the process, so other CLIs can embed
 * it with their own settings and command prefix.
 */
export async function runBrokerCli(args: readonly string[], io: CliIo): Promise<number> {
  const prefix = io.prefix ?? "beachside-broker";
  setHintPrefix(prefix);
  let json = args.includes("--json");

  try {
    const { values, positionals } = parseCommandOptions([...args]);
    json = Boolean(values.json);

    if (values.version) {
      io.stdout(json ? JSON.stringify({ version: clientVersion(io.env) }) : clientVersion(io.env));

      return 0;
    }

    if (values.help || !positionals.length) {
      io.stdout(helpText(prefix));

      return 0;
    }

    const [group, maybeCommand, ...rest] = positionals;
    const command = group === "status" ? undefined : maybeCommand;
    const operands = group === "status" ? [maybeCommand, ...rest].filter(Boolean) : rest;
    const key = command ? `${group} ${command}` : group!;
    const allowed = flagsFor(key);

    if (!allowed)
      return usageError(
        flagsFor(`${group} list`) || flagsFor(`${group} show`)
          ? `Unknown ${group} command. See \`${prefix} --help\``
          : `Unknown command ${JSON.stringify(group).slice(0, 40)}. See \`${prefix} --help\``,
      );

    for (const [flag, value] of Object.entries(values)) {
      if (value !== undefined && !globalFlags.has(flag) && !allowed.includes(flag))
        usageError(`--${flag} is not accepted by ${key}`);
    }

    const url = values.url ?? io.env.BEACHSIDE_BROKER_URL;

    if (!url)
      return usageError(
        "Set BEACHSIDE_BROKER_URL to the broker's origin, or pass --url https://your-broker.example.com (plain HTTP works for localhost)",
      );

    const base = brokerOrigin(url);

    const print = <Data extends object>(data: Data, text: string) =>
      io.stdout(json ? JSON.stringify(data) : text);

    const roleKey = async (role: "admin" | "issuer") => {
      const name = role === "admin" ? "BEACHSIDE_BROKER_ADMIN_KEY" : "BEACHSIDE_BROKER_ISSUER_KEY";
      const value = io.env[name];

      if (value) return resolveSecret(value, name, io.env);
      const entered = await io.promptKey?.(role);

      return (
        entered ||
        usageError(
          `${key} needs the ${role} key. Set ${name} to the key or a reference such as op://Private/beachside-broker/${role}`,
        )
      );
    };

    const adminKey = async () =>
      createCredentialBrokerAdmin({ url: base.origin, apiKey: await roleKey("admin") });

    const issuer = async () =>
      createCredentialBroker({ url: base.origin, auth: { apiKey: await roleKey("issuer") } });

    switch (key) {
      case "status": {
        noPositionals(operands);

        const client =
          io.env.BEACHSIDE_BROKER_ISSUER_KEY && !io.env.BEACHSIDE_BROKER_ADMIN_KEY
            ? await issuer()
            : await adminKey();

        const status = await client.status();

        print(
          { url: base.origin, ...status },
          [
            `broker    ${base.origin}`,
            `key       ${status.role}`,
            `api       v${status.apiVersion}`,
            `max ttl   ${formatDuration(status.limits.maxGrantTtlSeconds)}`,
            ...(status.counts
              ? [
                  `integrations  ${status.counts.integrations} (${status.counts.issuable} enabled and allowed to issue)`,
                  `active grants ${status.counts.activeGrants}`,
                ]
              : []),
          ].join("\n"),
        );

        return 0;
      }

      case "config show": {
        noPositionals(operands);
        const admin = await adminKey();
        const config = await admin.config();
        const workflows = config.githubActions?.workflows ?? [];

        print(
          config,
          [
            `issuer key            ${config.issuerKey ? "configured" : "not configured"}`,
            `worker secrets        ${config.workerSecretBindings}`,
            `github actions        ${config.githubActions ? `audience ${config.githubActions.audience}` : "not configured"}`,
            ...workflows.map(
              (workflow) =>
                `  ${policyText(workflow.workflowRef)} (${policyText(workflow.event)}): ${policyText(workflow.integrations)}`,
            ),
          ].join("\n"),
        );

        return 0;
      }

      case "integration setup": {
        noPositionals(operands);
        const admin = await adminKey();
        const config = await setupIntegration();
        const created = await admin.integrations.create(config);

        const allowedNow = values["no-allow-issue"]
          ? undefined
          : await allowCreated(admin, created.id);

        if (json) {
          io.stdout(JSON.stringify({ ...created, issuable: Boolean(allowedNow) }));

          return 0;
        }

        outro(`Created integration ${created.id}.`, { output: process.stderr });
        io.stderr(
          allowedNow
            ? `The issuer can now mint grants for ${created.id}. Try one with \`${prefix} grant issue ${created.id}\`.`
            : `Allow grants when ready with \`${prefix} issuer allow ${created.id}\`.`,
        );

        return 0;
      }

      case "integration list": {
        noPositionals(operands);
        const admin = await adminKey();
        const integrations = await admin.integrations.list();
        print({ integrations }, integrationLines(integrations));

        return 0;
      }

      case "integration show": {
        const [id] = integrationIds(operands, false);
        const admin = await adminKey();
        const item = await admin.integrations.get(id!);
        print(item, integrationDetail(item));

        return 0;
      }

      case "integration create": {
        const [id] = integrationIds(operands, false);
        const admin = await adminKey();
        let input: BrokerIntegrationInput;

        if (values.provider === "http") {
          if (
            !values["config-stdin"] ||
            values["secret-stdin"] ||
            values["worker-secret"] !== undefined
          )
            return usageError("HTTP integrations take only --config-stdin");

          input = await endpointFromStdin(id!);
        } else {
          if (values["config-stdin"]) return usageError("--config-stdin requires --provider http");

          input = {
            id: id!,
            kind: provider(values.provider),
            credential: await credentialFromFlags(values),
          };
        }

        const created = await admin.integrations.create(input);

        const issuable = values["allow-issue"]
          ? Boolean(await allowCreated(admin, created.id))
          : false;

        print(
          { ...created, issuable },
          `Created integration ${created.id}.${issuable ? " The issuer can mint grants for it." : `\nAllow grants with \`${prefix} issuer allow ${created.id}\`.`}`,
        );

        return 0;
      }

      case "integration rotate": {
        const [id] = integrationIds(operands, false);
        const admin = await adminKey();
        let rotated: BrokerIntegration;

        if (!values["credentials-stdin"]) {
          rotated = await admin.integrations.rotate(id!, await credentialFromFlags(values));
        } else {
          if (values["secret-stdin"] || values["worker-secret"] !== undefined)
            return usageError("Select exactly one credential source when rotating");
          const replacements = normalizeEndpointValues(await readJsonStdin());

          if (!replacements) return usageError("Expected replacement header secrets on stdin");

          rotated = await admin.integrations.rotate(id!, {
            source: "encrypted-store",
            values: replacements,
          });
        }

        print(rotated, `Rotated ${rotated.id} to credential version ${rotated.credentialVersion}.`);

        return 0;
      }

      case "integration enable":
      case "integration disable": {
        const [id] = integrationIds(operands, false);
        const enabled = command === "enable";
        const admin = await adminKey();
        const item = await admin.integrations.setEnabled(id!, enabled);

        print(
          item,
          enabled
            ? `Enabled ${item.id}.`
            : `Disabled ${item.id} and revoked its grants. Enable it again with \`${prefix} integration enable ${item.id}\`.`,
        );

        return 0;
      }

      case "integration delete": {
        const [id] = integrationIds(operands, false);
        const admin = await adminKey();
        await admin.integrations.delete(id!);
        print({ deleted: true, id }, `Deleted ${id} and revoked its grants.`);

        return 0;
      }

      case "issuer show": {
        noPositionals(operands);
        const admin = await adminKey();
        const { integrations } = await admin.issuerPermissions.get();
        print(
          { integrations },
          integrations.length
            ? `The issuer can mint grants for: ${integrations.join(", ")}`
            : `The issuer cannot mint grants yet. Allow an integration with \`${prefix} issuer allow <id>\`.`,
        );

        return 0;
      }

      case "issuer allow":
      case "issuer deny": {
        const ids = integrationIds(operands, true);
        const admin = await adminKey();
        let integrations: string[] = [];

        for (const id of ids) {
          ({ integrations } =
            command === "allow"
              ? await admin.issuerPermissions.allow(id)
              : await admin.issuerPermissions.deny(id));
        }

        print(
          { integrations },
          integrations.length
            ? `The issuer can mint grants for: ${integrations.join(", ")}`
            : "The issuer cannot mint grants for any integration.",
        );

        return 0;
      }

      case "issuer set": {
        const ids = operands.length ? integrationIds(operands, true) : [];
        const admin = await adminKey();
        const { integrations } = await admin.issuerPermissions.set(ids);
        print(
          { integrations },
          integrations.length
            ? `The issuer can mint grants for: ${integrations.join(", ")}`
            : "Cleared the allowlist. The issuer cannot mint new grants.",
        );

        return 0;
      }

      case "grant issue": {
        const integrations = integrationIds(operands, true);
        const ttlSeconds = values.ttl === undefined ? 900 : parseDuration(values.ttl);
        const broker = await issuer();
        const grant = await broker.issue({ integrations, ttlSeconds, label: values.label });

        if (values.token) {
          io.stdout(grant.token);

          return 0;
        }

        const gatewayUrls = Object.fromEntries(
          grant.integrations.map((id) => [
            id,
            integrationBaseURL(base, id, grantKind(grant.kinds, id)),
          ]),
        );

        print(
          { ...grant, gatewayUrls },
          [
            `grant     ${grant.id}`,
            `expires   ${grant.expiresAt} (${until(grant.expiresAt)})`,
            ...Object.entries(gatewayUrls).map(([id, address]) => `base url  ${id}: ${address}`),
            `token     ${grant.token}`,
            "",
            "Use the base URL as the client's API base and the token as its API key. Keep the token private.",
            `Revoke it early with \`${prefix} grant revoke ${grant.id}\`.`,
          ].join("\n"),
        );

        return 0;
      }

      case "grant list": {
        noPositionals(operands);

        const grants = values.all
          ? await (await adminKey()).grants.list()
          : await (await issuer()).list();

        print({ grants }, grantLines(grants, Boolean(values.all)));

        return 0;
      }

      case "grant renew": {
        if (operands.length !== 1) return usageError("Pass exactly one grant ID");
        const ttlSeconds = values.ttl === undefined ? 900 : parseDuration(values.ttl);
        const broker = await issuer();
        const renewed = await broker.renew(operands[0]!, ttlSeconds);
        print(
          renewed,
          `Renewed ${renewed.id}. It now expires ${renewed.expiresAt} (${until(renewed.expiresAt)}).`,
        );

        return 0;
      }

      case "grant revoke": {
        if (operands.length !== 1) return usageError("Pass exactly one grant ID");
        const broker = await issuer();
        await broker.revoke(operands[0]!);
        print({ revoked: true, id: operands[0] }, `Revoked ${operands[0]}.`);

        return 0;
      }
    }

    return usageError(`Unknown command. See \`${prefix} --help\``);
  } catch (error) {
    const known = error instanceof CredentialBrokerError;
    const code = known ? error.code : "INTERNAL";

    const message = known
      ? error.message
      : "The broker command failed unexpectedly. Run it again, and report it if it keeps failing";

    io.stderr(
      json
        ? JSON.stringify({
            error: {
              code,
              message,
              ...(known &&
                error.reason && { reason: error.reason, integrations: error.integrations }),
            },
          })
        : `${code}: ${message}`,
    );

    return known ? exitCodes[error.code] : 1;
  }
}
