import { execFile } from "node:child_process";
import { CredentialBrokerError } from "./transport.js";

type Env = Readonly<Record<string, string | undefined>>;

interface Manager {
  name: string;
  prefix: string;
  valid: (path: string) => boolean;
  command: string;
  args: (path: string) => string[];
  value: (stdout: string) => string;
  check: string;
}

const passSegment = /^[\w@+-][\w@+.-]*$/;

const managers: Manager[] = [
  {
    name: "1Password",
    prefix: "op://",
    valid: (path) => /^[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}(\?\S*)?$/.test(path),
    command: "op",
    args: (path) => ["read", "--no-newline", `op://${path}`],
    value: (stdout) => stdout,
    check:
      "Install the 1Password CLI, sign in with `op signin`, and check the vault, item and field",
  },
  {
    name: "Bitwarden Secrets Manager",
    prefix: "bws://",
    valid: (path) => /^[0-9a-fA-F-]{36}$/.test(path),
    command: "bws",
    args: (path) => ["secret", "get", path, "--output", "json"],
    value: (stdout) => {
      // SAFETY: `bws secret get --output json` prints the secret object; an empty value is rejected by the caller.
      const { value } = JSON.parse(stdout) as { value?: string };

      return String(value ?? "");
    },
    check:
      "Install the Bitwarden Secrets Manager CLI, set BWS_ACCESS_TOKEN, and check the secret ID",
  },
  {
    name: "pass",
    prefix: "pass://",
    valid: (path) => path.split("/").every((segment) => passSegment.test(segment)),
    command: "pass",
    args: (path) => ["show", path],
    value: (stdout) => stdout.split("\n")[0] ?? "",
    check: "Install pass, initialise your store, and check that `pass show <path>` works",
  },
];

/** Whether a setting names a secret elsewhere instead of holding it. */
export function isSecretReference(value: string): boolean {
  return value.startsWith("env:") || managers.some(({ prefix }) => value.startsWith(prefix));
}

/** The environment a password manager runs with: everything except other broker secrets. */
function managerEnvironment(env: Env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !/^(?:BEACHSIDE_BROKER_|BROKER_|CREDENTIAL_)/.test(name),
    ),
  );
}

/**
 * Resolves `env:NAME`, `op://`, `bws://` and `pass://` references through the password manager's
 * own CLI. An `env:` reference yields the variable's value as it is. Any other value is returned
 * unchanged.
 */
export async function resolveSecret(value: string, name: string, env: Env): Promise<string> {
  if (value.startsWith("env:")) {
    const resolved = env[value.slice("env:".length)];

    if (!resolved)
      throw new CredentialBrokerError(
        "INVALID_ARGUMENT",
        `${name} points at ${value}, which is not set`,
      );

    return resolved;
  }

  const manager = managers.find(({ prefix }) => value.startsWith(prefix));

  if (!manager) return value;
  const path = value.slice(manager.prefix.length);

  if (!manager.valid(path))
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      `${name} is not a valid ${manager.name} reference: ${value}`,
    );

  const { code, secret } = await new Promise<{ code: string | number; secret?: string }>((done) =>
    execFile(
      manager.command,
      manager.args(path),
      { env: managerEnvironment(env), timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return done({ code: error.code ?? "FAILED" });

        try {
          done({ code: 0, secret: manager.value(stdout) });
        } catch {
          done({ code: 0 });
        }
      },
    ),
  );

  // Only the exit status is reported: a manager's own output may describe or contain the secret.
  if (code === "ENOENT")
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      `${name} is a ${manager.name} reference, but \`${manager.command}\` is not installed. ${manager.check}`,
    );

  if (code !== 0)
    throw new CredentialBrokerError(
      "UNAVAILABLE",
      `Could not read ${name} from ${manager.name} (${value}): ${manager.command} exited with ${code}. ${manager.check}`,
    );

  if (!secret)
    throw new CredentialBrokerError(
      "UNAVAILABLE",
      `${manager.name} returned no value for ${name} (${value})`,
    );

  return secret;
}
