import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { terminalPrompt } from "../src/terminal.js";
import { confirmed, configureDeployment, loadDeploymentFile, setupError } from "./deployment-file";
import { CredentialBrokerError } from "../src/transport.js";
import { assertSeparateRoleKeys } from "../services/credential-broker/src/auth";
import { isBrokerApiKey } from "../services/credential-broker/src/auth/api-key";
import { parseConfig } from "../services/credential-broker/src/config";
import { credentialValue } from "../services/credential-broker/src/credentials/source";
import { encryptionKeyring } from "../services/credential-broker/src/credentials/sources/encrypted-store";
import {
  traceAuthorization,
  traceEndpoint,
} from "../services/credential-broker/src/observability/otlp";

const repository = resolve(import.meta.dir, "..");

const servicePath = "services/credential-broker";

const brokerSecrets = [
  "BROKER_ADMIN_KEY",
  "BROKER_ISSUER_KEY",
  "BROKER_ENCRYPTION_KEYS",
  "BROKER_ENCRYPTION_KEY_VERSION",
];

const environmentFile = ".env.deploy";

function hasBrokerCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.BROKER_ADMIN_KEY && env.BROKER_ENCRYPTION_KEYS && env.BROKER_ENCRYPTION_KEY_VERSION,
  );
}

function alchemyEnvironment(
  inherited: NodeJS.ProcessEnv,
  file: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const env = { ...inherited, ...file };

  if (!hasBrokerCredentials(env) || !env.ALCHEMY_PASSWORD)
    return setupError("Alchemy deployment requires the existing broker keys and ALCHEMY_PASSWORD");

  // Pinned Alchemy prefers a legacy API key even when the file supplies an API token.
  if (file?.CLOUDFLARE_API_TOKEN && !file.CLOUDFLARE_API_KEY) env.CLOUDFLARE_API_KEY = "";

  return env;
}

function workerSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  const {
    BROKER_ADMIN_KEY: admin,
    BROKER_ISSUER_KEY: issuer,
    BROKER_ENCRYPTION_KEYS: encoded,
    BROKER_ENCRYPTION_KEY_VERSION: active,
    BROKER_OTLP_TRACES_ENDPOINT: traceUrl,
    BROKER_OTLP_AUTHORIZATION: collectorAuthorization,
  } = env;

  if (
    !isBrokerApiKey(admin) ||
    (issuer !== undefined && !isBrokerApiKey(issuer)) ||
    !encoded ||
    !active
  )
    return setupError(
      "Configure valid broker role keys and an encryption keyring in .env.deploy or the environment",
    );

  const deployment = new Map([
    ["BROKER_ADMIN_KEY", admin],
    ["BROKER_ENCRYPTION_KEYS", encoded],
    ["BROKER_ENCRYPTION_KEY_VERSION", active],
  ]);

  if (issuer) deployment.set("BROKER_ISSUER_KEY", issuer);

  try {
    const config = parseConfig(env.BROKER_CONFIG ?? "{}");

    const keyring = encryptionKeyring({
      BROKER_ENCRYPTION_KEYS: encoded,
      BROKER_ENCRYPTION_KEY_VERSION: active,
    });

    assertSeparateRoleKeys(
      { BROKER_ADMIN_KEY: admin, BROKER_ISSUER_KEY: issuer },
      keyring.keys.values(),
    );

    if (!issuer && !config.githubActions)
      return setupError("Configure a broker issuer key, GitHub Actions OIDC, or both");
    deployment.set("BROKER_CONFIG", JSON.stringify(config));

    for (const name of config.workerSecretBindings) {
      const parsed = credentialValue.safeParse(env[name]);

      if (!parsed.success) return setupError(`Provide a valid Worker secret binding for ${name}`);
      deployment.set(name, parsed.data);
    }

    if (traceUrl !== undefined) {
      deployment.set("BROKER_OTLP_TRACES_ENDPOINT", traceEndpoint(traceUrl));

      if (collectorAuthorization !== undefined)
        deployment.set("BROKER_OTLP_AUTHORIZATION", traceAuthorization(collectorAuthorization));
    } else if (collectorAuthorization !== undefined) {
      return setupError(
        "Configure BROKER_OTLP_TRACES_ENDPOINT before adding collector authorization",
      );
    }
  } catch (error) {
    if (error instanceof CredentialBrokerError) throw error;

    return setupError(
      "Invalid broker policy, encryption keyring, role key separation, or trace configuration",
    );
  }

  return Object.fromEntries(deployment);
}

async function runCommand(root: string, env: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, "run", ...args], {
    cwd: resolve(root, servicePath),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const interrupt = () => {
    child.kill("SIGINT");
  };

  const terminate = () => {
    child.kill("SIGTERM");
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function needsWranglerLogin(root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const child = Bun.spawn([process.execPath, "run", "--silent", "wrangler", "whoami", "--json"], {
    cwd: resolve(root, servicePath),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  const [status, reply] = await Promise.all([child.exited, Bun.readableStreamToText(child.stdout)]);

  if (status === 0) return false;

  try {
    // Wrangler returns this structured result for a missing session. Other errors
    // are left to deploy, which can refresh credentials and report useful diagnostics.
    return JSON.parse(reply).loggedIn === false;
  } catch {
    return false;
  }
}

async function deployWrangler(
  root: string,
  inherited: NodeJS.ProcessEnv,
  settings: NodeJS.ProcessEnv,
  args: string[],
  setup: boolean,
): Promise<number> {
  const secrets = workerSecrets(settings);
  const env = { ...inherited };

  for (const name of Object.keys(env)) {
    if (/^(?:BROKER_|CREDENTIAL_|ALCHEMY_)/.test(name)) delete env[name];
  }

  if (settings.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = settings.CLOUDFLARE_API_TOKEN;

  if (settings.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = settings.CLOUDFLARE_ACCOUNT_ID;

  if (setup && !env.CLOUDFLARE_API_TOKEN && (await needsWranglerLogin(root, env))) {
    const login = await runCommand(root, env, ["wrangler", "login"]);

    if (login !== 0) return login;
  }

  const directory = mkdtempSync(resolve(tmpdir(), "broker-wrangler-"));

  try {
    const path = resolve(directory, "secrets.json");
    writeFileSync(path, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });

    return await runCommand(root, env, ["deploy:wrangler", ...args, "--secrets-file", path]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function deploy() {
  const args = process.argv.slice(2);
  const alchemy = args[0] === "--alchemy";

  if (alchemy) args.shift();
  const setupOnly = args[0] === "--setup-only";
  const firstArgument = args[0];
  const envPath = resolve(repository, environmentFile);
  const inherited = process.env;

  if (
    args.length === 1 &&
    (firstArgument === "--help" ||
      firstArgument === "-h" ||
      (!alchemy && firstArgument === "--dry-run"))
  )
    return runCommand(repository, inherited, [alchemy ? "deploy" : "deploy:wrangler", ...args]);
  const file = loadDeploymentFile(envPath);

  if (alchemy)
    return runCommand(repository, alchemyEnvironment(inherited, file), ["deploy", ...args]);

  if (
    args.some((argument) => argument === "--secrets-file" || argument.startsWith("--secrets-file="))
  )
    return setupError("Use bun run deploy:wrangler for a manually managed --secrets-file");
  const settings = { ...inherited, ...file };
  const statePath = resolve(repository, servicePath, settings.ALCHEMY_ROOT ?? ".", ".alchemy");

  if (
    file?.ALCHEMY_PASSWORD ||
    file?.ALCHEMY_STAGE ||
    (!file && settings.ALCHEMY_PASSWORD && settings.BROKER_ADMIN_KEY) ||
    existsSync(statePath)
  )
    return setupError(
      "Existing Alchemy deployment detected. Use bun run deploy:alchemy to retain its Worker and state",
    );

  if (file) {
    if (setupOnly)
      return setupError(".env.deploy already exists. Reuse or edit it to retain its keys");

    return deployWrangler(repository, inherited, settings, args, false);
  }

  if (!setupOnly && hasBrokerCredentials(inherited))
    return deployWrangler(repository, inherited, settings, args, false);

  if (brokerSecrets.some((name) => inherited[name]))
    return setupError(
      "Existing broker keys found. Restore the deployment configuration in .env.deploy or the environment",
    );

  if (args.length > (setupOnly ? 1 : 0))
    return setupError("Set up .env.deploy before passing Wrangler deployment options");

  const confirmDeploy = await terminalPrompt(
    "Deployment setup needs a terminal. Run bun run deploy:setup interactively or configure .env.deploy from .env.deploy.example",
    "Deployment setup cancelled",
    async (ask, write) => {
      if (!(await configureDeployment(envPath, ask, write))) return false;

      return (
        !setupOnly &&
        confirmed(await ask("Sign in to Cloudflare if needed and deploy now? [y/N]: "))
      );
    },
  );

  if (!confirmDeploy) return 0;
  const created = loadDeploymentFile(envPath);

  if (!created) return setupError(".env.deploy is missing. Restore it before deploying");

  return deployWrangler(repository, inherited, { ...inherited, ...created }, [], true);
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
