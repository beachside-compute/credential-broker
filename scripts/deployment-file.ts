import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { isSecretReference } from "../src/secret-ref.js";
import { brokerOrigin, CredentialBrokerError } from "../src/transport.js";

export function setupError(message: string): never {
  throw new CredentialBrokerError("INVALID_ARGUMENT", message);
}

/** Opens the file without following a symlink, and only if it is private and regular. */
function openPrivate(path: string, flags: number): number | undefined {
  let file: number;

  try {
    file = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;

    return setupError("Could not open .env.deploy as a regular file");
  }

  const stat = fstatSync(file);

  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    closeSync(file);

    return setupError(".env.deploy must be a private regular file. Use chmod 600 .env.deploy");
  }

  return file;
}

function parse(text: string): NodeJS.ProcessEnv {
  try {
    return parseEnv(text);
  } catch {
    return setupError("Could not read .env.deploy. Check the file's dotenv syntax");
  }
}

export function loadDeploymentFile(path: string): NodeJS.ProcessEnv | undefined {
  const file = openPrivate(path, constants.O_RDONLY);

  if (file === undefined) return;

  try {
    return parse(readFileSync(file, "utf8"));
  } finally {
    closeSync(file);
  }
}

export function randomKey(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

/** The Worker secrets that only the first deploy sets. */
export const keySecrets = [
  "BROKER_ADMIN_KEY",
  "BROKER_ISSUER_KEY",
  "BROKER_ENCRYPTION_KEYS",
  "BROKER_ENCRYPTION_KEY_VERSION",
] as const;

/** Fresh, independent broker keys, held only in memory until the first deploy uploads them. */
export function generateKeys(): Record<(typeof keySecrets)[number], string> {
  const version = "v1";

  return {
    BROKER_ADMIN_KEY: randomKey(),
    BROKER_ISSUER_KEY: randomKey(),
    BROKER_ENCRYPTION_KEYS: JSON.stringify({ [version]: randomKey() }),
    BROKER_ENCRYPTION_KEY_VERSION: version,
  };
}

/** Keys an older setup saved in the file as values rather than references. */
export function plaintextKeys(file: NodeJS.ProcessEnv | undefined): string[] {
  return [...keySecrets, "BROKER_PLATFORM_KEY"].filter((name) => {
    const value = file?.[name];

    return (
      value !== undefined && name !== "BROKER_ENCRYPTION_KEY_VERSION" && !isSecretReference(value)
    );
  });
}

/** The warning for keys an older setup left in the file. */
export function plaintextWarning(names: readonly string[]): string {
  const roles = names.filter((name) => name !== "BROKER_ENCRYPTION_KEYS");

  return [
    `.env.deploy holds ${names.join(", ")} in plaintext.`,
    roles.length
      ? `Save ${roles.join(" and ")} in your password manager and replace each value with a reference such as op://Private/beachside-broker/admin.`
      : "",
    names.includes("BROKER_ENCRYPTION_KEYS")
      ? "Delete BROKER_ENCRYPTION_KEYS and BROKER_ENCRYPTION_KEY_VERSION once your last deploy has succeeded: the Worker already holds them."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** What saving the URL did: the URL it replaced, if any, and whether the file changed. */
export interface SavedURL {
  previous?: string;
  changed: boolean;
}

/**
 * Records the broker's origin in the file, creating it if needed. A different saved URL is
 * replaced, because the broker commands send the file's keys to it. Returns the URL it replaced.
 */
export function saveBrokerURL(path: string, url: string): SavedURL {
  const origin = brokerOrigin(url).origin;
  const file = openPrivate(path, constants.O_RDWR | constants.O_CREAT);

  if (file === undefined) return setupError("Could not create .env.deploy");

  try {
    const text = readFileSync(file, "utf8");
    const previous = parse(text).BEACHSIDE_BROKER_URL;

    if (previous === origin) return { previous, changed: false };
    const line = `BEACHSIDE_BROKER_URL=${origin}`;

    const updated =
      previous === undefined
        ? `${text || "# Broker settings. Reference keys with op://, bws://, pass:// or env:NAME.\n"}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`
        : text.replace(/^\s*(?:export\s+)?BEACHSIDE_BROKER_URL\s*=.*$/m, line);

    ftruncateSync(file);
    writeSync(file, updated, 0);

    return { previous, changed: true };
  } catch (error) {
    if (error instanceof CredentialBrokerError) throw error;

    return setupError(
      "Could not save BEACHSIDE_BROKER_URL to .env.deploy. Check the path and permissions",
    );
  } finally {
    closeSync(file);
  }
}
