import { execFile } from "node:child_process";
import { CredentialBrokerError } from "./transport.js";

type Env = Readonly<Record<string, string | undefined>>;

interface Manager {
  name: string;
  pattern: RegExp;
  command: string;
  args: (reference: string) => string[];
  value: (stdout: string) => string;
  install: string;
}

const managers: Manager[] = [
  {
    name: "1Password",
    pattern: /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}(\?\S*)?$/,
    command: "op",
    args: (reference) => ["read", "--no-newline", reference],
    value: (stdout) => stdout,
    install: "Install the 1Password CLI and sign in with `op signin`",
  },
  {
    name: "Bitwarden Secrets Manager",
    pattern: /^bws:\/\/[0-9a-fA-F-]{36}$/,
    command: "bws",
    args: (reference) => ["secret", "get", reference.slice("bws://".length), "--output", "json"],
    value: (stdout) => {
      // SAFETY: `bws secret get --output json` prints the secret object; an empty value is rejected by the caller.
      const { value } = JSON.parse(stdout) as { value?: string };

      return String(value ?? "");
    },
    install: "Install the Bitwarden Secrets Manager CLI and set BWS_ACCESS_TOKEN",
  },
  {
    name: "pass",
    pattern: /^pass:\/\/(?!.*(^|\/)\.\.(\/|$))[\w@+.-]+(\/[\w@+.-]+)*$/,
    command: "pass",
    args: (reference) => ["show", reference.slice("pass://".length)],
    value: (stdout) => stdout.split("\n")[0] ?? "",
    install: "Install pass and initialise your store",
  },
];

/** Whether a setting names a secret elsewhere instead of holding it. */
export function isSecretReference(value: string): boolean {
  return /^(?:env:|op:\/\/|bws:\/\/|pass:\/\/)/.test(value);
}

/**
 * Resolves `env:NAME`, `op://`, `bws://` and `pass://` references through the password manager's
 * own CLI. Any other value is returned as it is.
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

  if (!isSecretReference(value)) return value;
  const manager = managers.find((candidate) => candidate.pattern.test(value));

  if (!manager)
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      `${name} is not a valid reference: ${value}`,
    );

  const result = await new Promise<{ code: string | number; stdout: string; stderr: string }>(
    (done) =>
      execFile(
        manager.command,
        manager.args(value),
        { env: { ...env }, timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) =>
          done({ code: error ? (error.code ?? "FAILED") : 0, stdout, stderr }),
      ),
  );

  if (result.code === "ENOENT")
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      `${name} is a ${manager.name} reference, but \`${manager.command}\` is not installed. ${manager.install}`,
    );

  if (result.code !== 0)
    throw new CredentialBrokerError(
      "UNAVAILABLE",
      `Could not read ${name} from ${manager.name} (${value}): ${result.stderr.trim() || `${manager.command} exited with ${result.code}`}`,
    );

  try {
    const secret = manager.value(result.stdout);

    if (secret) return secret;
  } catch {}

  throw new CredentialBrokerError(
    "UNAVAILABLE",
    `${manager.name} returned no value for ${name} (${value})`,
  );
}
