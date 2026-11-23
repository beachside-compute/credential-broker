import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  generateKeys,
  keySecrets,
  loadDeploymentFile,
  plaintextKeys,
  saveBrokerURL,
  setupError,
} from "./deployment-file";
import { CredentialBrokerError } from "../src/transport.js";
import { parseConfig } from "../services/credential-broker/src/config";
import { credentialValue } from "../services/credential-broker/src/credentials/source";
import {
  traceAuthorization,
  traceEndpoint,
} from "../services/credential-broker/src/observability/otlp";

const repository = resolve(import.meta.dir, "..");

const servicePath = "services/credential-broker";

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

/** Worker secrets that every deploy may update. The broker keys are set only by the first deploy. */
function settingSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  const {
    BROKER_OTLP_TRACES_ENDPOINT: traceUrl,
    BROKER_OTLP_AUTHORIZATION: collectorAuthorization,
  } = env;

  const deployment = new Map<string, string>();

  try {
    const config = parseConfig(env.BROKER_CONFIG ?? "{}");
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

    return setupError("Invalid broker policy or trace configuration");
  }

  return Object.fromEntries(deployment);
}

/** Cloudflare's reply when Wrangler reads back a Worker its first upload just created. */
const firstDeployRace = /code: 10007\]/;

interface Run {
  /** Sees stdout and stderr as they are forwarded. */
  watch?: (text: string) => void;
  /** Captures stdout instead of forwarding it. */
  capture?: boolean;
}

async function runCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  { watch, capture }: Run = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const piped = Boolean(watch || capture);

  const child = Bun.spawn([process.execPath, "run", ...args], {
    cwd: resolve(root, servicePath),
    env,
    stdin: capture ? "ignore" : "inherit",
    stdout: piped ? "pipe" : "inherit",
    stderr: piped ? "pipe" : "inherit",
  });

  const output = { stdout: "", stderr: "" };

  const forward = async (
    stream: ReadableStream<Uint8Array> | number | undefined,
    name: "stdout" | "stderr",
  ) => {
    if (!(stream instanceof ReadableStream)) return;
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });

      if (capture) output[name] += text;
      else process[name].write(chunk);
      watch?.(text);
    }
  };

  const forwarded = Promise.all([forward(child.stdout, "stdout"), forward(child.stderr, "stderr")]);

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

    return { code, ...output };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/** The environment Wrangler runs with: Cloudflare account settings, but no broker settings. */
function wranglerEnvironment(
  inherited: NodeJS.ProcessEnv,
  settings: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...inherited };

  for (const name of Object.keys(env)) {
    if (/^(?:BROKER_|CREDENTIAL_|ALCHEMY_)/.test(name)) delete env[name];
  }

  if (settings.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = settings.CLOUDFLARE_API_TOKEN;

  if (settings.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = settings.CLOUDFLARE_ACCOUNT_ID;

  return env;
}

/** Names of the secrets the deployed Worker has, or none when it does not exist yet. */
async function workerSecretNames(root: string, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const { code, stdout, stderr } = await runCommand(
    root,
    env,
    ["wrangler", "secret", "list", "--format", "json"],
    { capture: true },
  );

  if (code !== 0) {
    if (/not found/i.test(stderr + stdout)) return new Set();
    process.stderr.write(stderr);

    return setupError("Could not read the Worker's secrets. Check `wrangler login` and try again");
  }

  try {
    const listed: { name: string }[] = JSON.parse(stdout.slice(stdout.indexOf("[")));

    return new Set(listed.map((secret) => secret.name));
  } catch {
    return setupError("Could not read the Worker's secrets from Wrangler's output");
  }
}

/** The origin Wrangler printed for the deployed Worker. */
function deployedOrigin(output: string): string | undefined {
  const workersDev = /https:\/\/[\w.-]+\.workers\.dev\b/.exec(output)?.[0];

  if (workersDev) return workersDev;
  const custom = /^\s*([\w.-]+\.[a-z]{2,}) \(custom domain\)\s*$/im.exec(output)?.[1];

  return custom && `https://${custom}`;
}

async function deployWrangler(
  root: string,
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
  args: string[],
): Promise<{ code: number; url?: string }> {
  const directory = mkdtempSync(resolve(tmpdir(), "broker-wrangler-"));

  try {
    const path = resolve(directory, "secrets.json");
    writeFileSync(path, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });

    const command = ["deploy:wrangler", ...args, "--secrets-file", path];
    let raced = false;
    let tail = "";
    let printed = "";

    const watch = (text: string) => {
      tail = (tail + text).slice(-512);
      printed = (printed + text).slice(-16_384);
      raced ||= firstDeployRace.test(tail);
    };

    let { code } = await runCommand(root, env, command, { watch });

    if (code !== 0 && raced) {
      // A Worker's first deploy can upload, then fail to read itself back while the Workers API
      // catches up. The upload landed, so one more deploy finishes it.
      console.info("Cloudflare had not registered the new Worker yet. Deploying again.");
      await Bun.sleep(5_000);
      ({ code } = await runCommand(root, env, command, { watch }));
    }

    return { code, url: deployedOrigin(printed) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function printKeys(keys: ReturnType<typeof generateKeys>) {
  console.info(
    [
      "",
      "Save these two keys in your password manager now. They are not stored anywhere else.",
      "",
      `  BROKER_ADMIN_KEY=${keys.BROKER_ADMIN_KEY}`,
      `  BROKER_ISSUER_KEY=${keys.BROKER_ISSUER_KEY}`,
      "",
      "Then point .env.deploy at them, for example:",
      "",
      "  BROKER_ADMIN_KEY=op://Private/beachside-broker/admin",
      "  BROKER_ISSUER_KEY=op://Private/beachside-broker/issuer",
      "",
      "bws://<secret-id>, pass://<path> and env:NAME references work too.",
      "The encryption key went straight to the Worker and is not shown.",
    ].join("\n"),
  );
}

async function setup(
  envPath: string,
  inherited: NodeJS.ProcessEnv,
  file: NodeJS.ProcessEnv | undefined,
  settings: NodeJS.ProcessEnv,
): Promise<number> {
  if (keySecrets.some((name) => file?.[name] || inherited[name]))
    return setupError(
      "Broker keys are already configured, so this broker has been set up. Update it with bun run deploy",
    );
  const secrets = settingSecrets(settings);
  const env = wranglerEnvironment(inherited, settings);

  if ((await workerSecretNames(repository, env)).has("BROKER_ENCRYPTION_KEYS"))
    return setupError(
      "The broker Worker already has its keys. Update it with bun run deploy; setup never replaces them",
    );
  const keys = generateKeys();
  const { code, url } = await deployWrangler(repository, env, { ...secrets, ...keys }, []);

  if (code !== 0) {
    console.error(
      "Deploy failed, so the new keys were discarded. Fix the error above and run bun run deploy:setup again. If setup then says the Worker already has keys, delete the new Worker with `bun run --cwd services/credential-broker wrangler delete` first.",
    );

    return code;
  }

  const origin = settings.BEACHSIDE_BROKER_URL ?? url;

  console.info(
    origin && saveBrokerURL(envPath, origin)
      ? `Deployed ${origin} and saved it to .env.deploy.`
      : origin
        ? `Deployed ${origin}.`
        : "Deployed. Save the HTTPS origin Wrangler printed as BEACHSIDE_BROKER_URL in .env.deploy.",
  );
  printKeys(keys);

  return 0;
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
    return (
      await runCommand(repository, inherited, [alchemy ? "deploy" : "deploy:wrangler", ...args])
    ).code;
  const file = loadDeploymentFile(envPath);

  if (alchemy)
    return (await runCommand(repository, alchemyEnvironment(inherited, file), ["deploy", ...args]))
      .code;

  if (setupOnly && args.length !== 1) return setupError("bun run deploy:setup takes no options");

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

  if (setupOnly) return setup(envPath, inherited, file, settings);

  const plaintext = plaintextKeys(file);

  if (plaintext.length)
    console.warn(
      `.env.deploy holds ${plaintext.join(", ")} in plaintext. Deploys never upload keys, so save them in your password manager, replace each value with a reference such as op://Private/beachside-broker/admin, and delete BROKER_ENCRYPTION_KEYS.`,
    );

  const secrets = settingSecrets(settings);
  const env = wranglerEnvironment(inherited, settings);

  if (!args.includes("--dry-run")) {
    const existing = await workerSecretNames(repository, env);

    if (!existing.has("BROKER_ADMIN_KEY") || !existing.has("BROKER_ENCRYPTION_KEYS"))
      return setupError("This broker has not been set up yet. Run bun run deploy:setup first");
  }

  const { code, url } = await deployWrangler(repository, env, secrets, args);

  if (code === 0 && !args.includes("--dry-run")) {
    const saved = !settings.BEACHSIDE_BROKER_URL && url && saveBrokerURL(envPath, url);

    console.info(
      settings.BEACHSIDE_BROKER_URL || saved
        ? `Deployed${saved ? ` ${url} and saved it to .env.deploy` : ""}. Check it with \`bun run broker status\`.`
        : "Deployed. Save the HTTPS origin Wrangler printed as BEACHSIDE_BROKER_URL in .env.deploy, then run `bun run broker status`.",
    );
  }

  return code;
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
