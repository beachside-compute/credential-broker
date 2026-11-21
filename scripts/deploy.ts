import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateDeploymentFile, loadDeploymentFile, setupError } from "./deployment-file";
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

/** Cloudflare's reply when Wrangler reads back a Worker its first upload just created. */
const firstDeployRace = /code: 10007\]/;

async function runCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  onError?: (text: string) => void,
): Promise<number> {
  const child = Bun.spawn([process.execPath, "run", ...args], {
    cwd: resolve(root, servicePath),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: onError ? "pipe" : "inherit",
  });

  // Forward stderr as it arrives while letting the caller look for a known failure.
  const stderr = child.stderr;

  const forwarded =
    onError && stderr
      ? (async () => {
          const decoder = new TextDecoder();

          for await (const chunk of stderr) {
            process.stderr.write(chunk);
            onError(decoder.decode(chunk, { stream: true }));
          }
        })()
      : undefined;

  const interrupt = () => {
    child.kill("SIGINT");
  };

  const terminate = () => {
    child.kill("SIGTERM");
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    const code = await child.exited;
    await forwarded;

    return code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function deployWrangler(
  root: string,
  inherited: NodeJS.ProcessEnv,
  settings: NodeJS.ProcessEnv,
  args: string[],
): Promise<number> {
  const secrets = workerSecrets(settings);
  const env = { ...inherited };

  for (const name of Object.keys(env)) {
    if (/^(?:BROKER_|CREDENTIAL_|ALCHEMY_)/.test(name)) delete env[name];
  }

  if (settings.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = settings.CLOUDFLARE_API_TOKEN;

  if (settings.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = settings.CLOUDFLARE_ACCOUNT_ID;

  const directory = mkdtempSync(resolve(tmpdir(), "broker-wrangler-"));

  try {
    const path = resolve(directory, "secrets.json");
    writeFileSync(path, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });

    const command = ["deploy:wrangler", ...args, "--secrets-file", path];
    let raced = false;
    let tail = "";

    const code = await runCommand(root, env, command, (text) => {
      tail = (tail + text).slice(-512);
      raced ||= firstDeployRace.test(tail);
    });

    if (code === 0 || !raced) return code;

    // A Worker's first deploy can upload, then fail to read itself back while the Workers API
    // catches up. The upload landed, so one more deploy finishes it.
    console.info("Cloudflare had not registered the new Worker yet. Deploying again.");
    await Bun.sleep(5_000);

    return await runCommand(root, env, command);
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

  if (setupOnly) {
    if (args.length !== 1) return setupError("bun run deploy:setup takes no options");

    if (file) {
      console.info("Keeping the existing .env.deploy.");

      return 0;
    }
  }

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

  if (setupOnly) {
    if (brokerSecrets.some((name) => inherited[name]))
      return setupError(
        "Broker settings already exist in the environment. Retain and reuse those keys",
      );
    const created = generateDeploymentFile(envPath);
    console.info(
      created
        ? "Saved .env.deploy. Keep it private and back up its keys securely."
        : "Keeping the existing .env.deploy.",
    );

    return 0;
  }

  if (!file && !hasBrokerCredentials(inherited))
    return setupError(
      "Run bun run deploy:setup or supply the existing broker settings before deploying",
    );

  const status = await deployWrangler(repository, inherited, settings, args);

  if (status === 0 && !args.includes("--dry-run"))
    console.info(
      settings.BEACHSIDE_BROKER_URL
        ? "Deployed. Check it with `bun run broker status`, then add an integration with `bun run broker integration setup`."
        : "Deployed. Save the HTTPS origin Wrangler printed as BEACHSIDE_BROKER_URL in .env.deploy, then run `bun run broker status` and `bun run broker integration setup`.",
    );

  return status;
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
