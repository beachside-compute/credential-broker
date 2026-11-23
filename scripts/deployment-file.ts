import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { isSecretReference } from "../src/secret-ref.js";
import { CredentialBrokerError } from "../src/transport.js";

export function setupError(message: string): never {
  throw new CredentialBrokerError("INVALID_ARGUMENT", message);
}

export function loadDeploymentFile(path: string): NodeJS.ProcessEnv | undefined {
  let file: number;

  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;

    return setupError("Could not open .env.deploy as a regular file");
  }

  try {
    const stat = fstatSync(file);

    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      return setupError(".env.deploy must be a private regular file. Use chmod 600 .env.deploy");

    try {
      return parseEnv(readFileSync(file, "utf8"));
    } catch {
      return setupError("Could not read .env.deploy. Check the file's dotenv syntax");
    }
  } finally {
    closeSync(file);
  }
}

function randomKey(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

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

/** The Worker secrets that only the first deploy sets. */
export const keySecrets = [
  "BROKER_ADMIN_KEY",
  "BROKER_ISSUER_KEY",
  "BROKER_ENCRYPTION_KEYS",
  "BROKER_ENCRYPTION_KEY_VERSION",
] as const;

/** Keys an older setup saved in the file as values rather than references. */
export function plaintextKeys(file: NodeJS.ProcessEnv | undefined): string[] {
  return keySecrets.filter((name) => {
    const value = file?.[name];

    return (
      value !== undefined && name !== "BROKER_ENCRYPTION_KEY_VERSION" && !isSecretReference(value)
    );
  });
}

/** Records the broker's origin in the file, creating it if needed. An existing URL is kept. */
export function saveBrokerURL(path: string, url: string): boolean {
  const file = loadDeploymentFile(path);

  if (file?.BEACHSIDE_BROKER_URL) return false;

  try {
    if (file) {
      const text = readFileSync(path, "utf8");
      appendFileSync(
        path,
        `${text && !text.endsWith("\n") ? "\n" : ""}BEACHSIDE_BROKER_URL=${url}\n`,
      );
    } else
      writeFileSync(
        path,
        `# Broker settings. Keys belong in your password manager; reference them with op://, bws://, pass:// or env:NAME.\nBEACHSIDE_BROKER_URL=${url}\n`,
        { flag: "wx", mode: 0o600 },
      );
  } catch {
    return setupError(
      "Could not save BEACHSIDE_BROKER_URL to .env.deploy. Check the path and permissions",
    );
  }

  return true;
}
