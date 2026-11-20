import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
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

export function generateDeploymentFile(path: string): boolean {
  if (loadDeploymentFile(path)) return false;

  const active = "v1";

  const contents = [
    "# Private deployment configuration. Back up the broker keys securely.",
    `BROKER_ADMIN_KEY=${randomKey()}`,
    `BROKER_ISSUER_KEY=${randomKey()}`,
    `BROKER_ENCRYPTION_KEYS='${JSON.stringify({ [active]: randomKey() })}'`,
    `BROKER_ENCRYPTION_KEY_VERSION=${active}`,
    "",
  ].join("\n");

  try {
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST" &&
      loadDeploymentFile(path)
    )
      return false;

    return setupError("Could not create .env.deploy. Check the path and permissions");
  }

  return true;
}
