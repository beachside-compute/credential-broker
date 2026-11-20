import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { terminalPrompt, type Ask } from "../src/terminal.js";
import { CredentialBrokerError } from "../src/transport.js";

const repository = resolve(import.meta.dir, "..");

const servicePath = "services/credential-broker";

const brokerSecrets = [
  "BROKER_ADMIN_KEY",
  "BROKER_ISSUER_KEY",
  "BROKER_ENCRYPTION_KEYS",
  "BROKER_ENCRYPTION_KEY_VERSION",
  "ALCHEMY_PASSWORD",
];

const environmentFile = ".env.deploy";

function setupError(message: string): never {
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
  return randomBytes(32).toString("base64url");
}

function confirmed(value: string): boolean {
  return ["y", "yes"].includes(value.trim().toLowerCase());
}

export async function configureDeployment(
  path: string,
  ask: Ask,
  write: (message: string) => void,
): Promise<boolean> {
  if (loadDeploymentFile(path))
    return setupError(".env.deploy already exists. Reuse or edit it to retain its keys");
  write("Create deployment configuration for a Cloudflare Worker.\n");
  const account = (await ask("Cloudflare account ID: ")).trim();

  if (!/^[a-f0-9]{32}$/i.test(account))
    return setupError("Enter a 32-character hexadecimal Cloudflare account ID");
  const token = (await ask("Cloudflare API token: ", true)).trim();

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(token))
    return setupError(
      "Enter a Cloudflare API token containing only letters, digits, hyphens, or underscores",
    );

  if (!confirmed(await ask("Save .env.deploy with new broker and Alchemy keys? [y/N]: "))) {
    write("Deployment setup cancelled.\n");

    return false;
  }

  const stage = "production";
  const active = "v1";

  const contents = [
    "# Private deployment configuration. Keep this file and the Alchemy state together.",
    `CLOUDFLARE_ACCOUNT_ID=${account}`,
    `CLOUDFLARE_API_TOKEN=${token}`,
    `ALCHEMY_STAGE=${stage}`,
    `ALCHEMY_PASSWORD=${randomKey()}`,
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

  write(
    "Saved .env.deploy. Keep it private and retain it with the Alchemy state for future deployments.\n",
  );

  return true;
}

function hasBrokerCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.BROKER_ADMIN_KEY &&
    env.BROKER_ENCRYPTION_KEYS &&
    env.BROKER_ENCRYPTION_KEY_VERSION &&
    env.ALCHEMY_PASSWORD,
  );
}

export function deploymentEnvironment(
  inherited: NodeJS.ProcessEnv,
  file: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!hasBrokerCredentials(file))
    return setupError(
      "Complete the broker keys and Alchemy password in .env.deploy before deploying",
    );
  const env = { ...inherited, ...file };

  // Pinned Alchemy otherwise prefers a legacy API key over the file's explicit API token.
  if (file.CLOUDFLARE_API_TOKEN && !file.CLOUDFLARE_API_KEY) env.CLOUDFLARE_API_KEY = "";

  return env;
}

export function launchDeployment(
  root: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<number> {
  const child = Bun.spawn([process.execPath, "run", "deploy", ...args], {
    cwd: resolve(root, servicePath),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  return child.exited;
}

async function deploy() {
  const args = process.argv.slice(2);
  const setupOnly = args[0] === "--setup-only";
  const envPath = resolve(repository, environmentFile);
  const inherited = process.env;

  if (args[0] === "--help" || args[0] === "-h")
    return launchDeployment(repository, inherited, args);
  const file = loadDeploymentFile(envPath);

  if (file) {
    if (setupOnly)
      return setupError(".env.deploy already exists. Reuse or edit it to retain its keys");

    return launchDeployment(repository, deploymentEnvironment(inherited, file), args);
  }

  if (!setupOnly && hasBrokerCredentials(inherited))
    return launchDeployment(repository, inherited, args);
  const statePath = resolve(repository, servicePath, inherited.ALCHEMY_ROOT ?? ".", ".alchemy");

  if (brokerSecrets.some((name) => inherited[name]) || existsSync(statePath))
    return setupError(
      "Existing broker credentials or Alchemy state found. Restore the deployment keys in .env.deploy or the environment before deploying",
    );

  if (args.length > (setupOnly ? 1 : 0))
    return setupError("Set up .env.deploy before passing Alchemy deployment options");

  const shouldDeploy = await terminalPrompt(
    "Deployment setup needs a terminal. Run bun run deploy:setup interactively or configure .env.deploy from .env.deploy.example",
    "Deployment setup cancelled",
    async (ask, write) => {
      if (!(await configureDeployment(envPath, ask, write))) return false;

      return !setupOnly && confirmed(await ask("Deploy to Cloudflare now? [y/N]: "));
    },
  );

  if (shouldDeploy) {
    const created = loadDeploymentFile(envPath);

    if (!created) return setupError(".env.deploy is missing. Restore it before deploying");

    return launchDeployment(repository, deploymentEnvironment(inherited, created), args);
  }

  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await deploy();
  } catch (error) {
    console.error(
      error instanceof CredentialBrokerError ? error.message : "Could not start broker deployment",
    );
    process.exitCode = 1;
  }
}
