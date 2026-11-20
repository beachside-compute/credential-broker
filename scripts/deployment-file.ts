import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Ask } from "../src/terminal.js";
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

export function confirmed(value: string): boolean {
  return ["y", "yes"].includes(value.trim().toLowerCase());
}

export async function configureDeployment(
  path: string,
  ask: Ask,
  write: (message: string) => void,
): Promise<boolean> {
  if (loadDeploymentFile(path))
    return setupError(".env.deploy already exists. Reuse or edit it to retain its keys");

  if (!confirmed(await ask("Generate broker keys and save .env.deploy? [y/N]: "))) {
    write("Deployment setup cancelled.\n");

    return false;
  }

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
  } catch {
    return setupError(
      "Could not create .env.deploy. Existing files are kept; check the path and permissions",
    );
  }

  write("Saved .env.deploy. Keep it private and reuse its keys for future deployments.\n");

  return true;
}
