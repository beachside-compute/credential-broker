import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  generateKeys,
  keySecrets,
  loadDeploymentFile,
  plaintextKeys,
  plaintextWarning,
  randomKey,
  saveBrokerURL,
  setupError,
} from "./deployment-file";
import { isSecretReference, resolveSecret } from "../src/secret-ref.js";
import { CredentialBrokerError } from "../src/transport.js";
import { brokerHosts, wranglerHostConfig } from "../services/credential-broker/src/tenants/hosts";
import { parseConfig } from "../services/credential-broker/src/config";
import { credentialValue } from "../services/credential-broker/src/credentials/source";
import {
  traceAuthorization,
  traceEndpoint,
} from "../services/credential-broker/src/observability/otlp";

const repository = resolve(import.meta.dir, "..");

const servicePath = "services/credential-broker";

const environmentFile = ".env.deploy";

/** Wrangler's reply when the Worker does not exist yet. */
const workerNotFound = /Worker "[^"]+"(?: \(env: [^)]+\))? not found\./;

/** Cloudflare's reply when Wrangler reads back a Worker its first upload just created. */
const firstDeployRace = /code: 10007\]/;

const emailAddress = /^[^\s@]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,}$/i;

/** The validated email alert sender, if the deployment sets one. */
function emailSender(env: NodeJS.ProcessEnv): string | undefined {
  const from = env.BROKER_EMAIL_FROM;

  if (from === undefined) return;

  return emailAddress.test(from)
    ? from
    : setupError("BROKER_EMAIL_FROM must be one email address on your onboarded domain");
}

/** An operator's untracked Wrangler settings, merged over the tracked config at deploy. */
const localConfig = "wrangler.local.jsonc";

const repositoryOwnedKeys = ["main", "durable_objects", "migrations"];

function readConfig(path: string) {
  return Object.assign({}, Bun.JSONC.parse(readFileSync(path, "utf8")));
}

/**
 * Deploy from a generated config when the operator has local settings or an email sender. Each run
 * writes its own copy beside the original, so relative paths resolve and runs never share one.
 */
async function withDeployConfig<T>(
  emailFrom: string | undefined,
  run: (args: string[]) => Promise<T>,
): Promise<T> {
  const service = resolve(repository, servicePath);
  const local = resolve(service, localConfig);

  if (!emailFrom && !existsSync(local)) return run([]);

  let config;
  let overrides = {};

  try {
    if (existsSync(local)) overrides = readConfig(local);
    config = { ...readConfig(resolve(service, "wrangler.jsonc")), ...overrides };
  } catch {
    return setupError(`Could not parse services/credential-broker/${localConfig}`);
  }

  try {
    brokerHosts(wranglerHostConfig.parse(config).vars ?? {});
  } catch {
    return setupError(
      "Invalid BROKER_TENANT_DOMAIN or BROKER_HOST_ALIASES in wrangler.local.jsonc",
    );
  }

  const owned = repositoryOwnedKeys.filter((key) => key in overrides);

  if (owned.length) {
    return setupError(
      `${localConfig} cannot set ${owned.join(", ")}; they belong to wrangler.jsonc`,
    );
  }

  const path = resolve(service, `wrangler.deploy.${crypto.randomUUID()}.json`);

  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      ...(emailFrom && {
        send_email: [{ name: "EMAIL", allowed_sender_addresses: [emailFrom] }],
      }),
    }),
    { flag: "wx" },
  );

  try {
    return await run(["--config", path]);
  } finally {
    rmSync(path, { force: true });
  }
}

/** Worker secrets that every deploy may update. The broker keys are set only by the first deploy. */
async function settingSecrets(
  env: NodeJS.ProcessEnv,
  platformEnabled = false,
): Promise<Record<string, string>> {
  const deployment = new Map<string, string>();
  const read = (name: string) => resolveSecret(env[name]!, name, env);

  try {
    const config = parseConfig(env.BROKER_CONFIG ?? "{}", platformEnabled);
    deployment.set("BROKER_CONFIG", JSON.stringify(config));

    for (const name of config.workerSecretBindings) {
      const parsed = credentialValue.safeParse(env[name] && (await read(name)));

      if (!parsed.success) return setupError(`Provide a valid Worker secret binding for ${name}`);
      deployment.set(name, parsed.data);
    }

    const from = emailSender(env);

    if (from) deployment.set("BROKER_EMAIL_FROM", from);

    if (env.BROKER_OTLP_TRACES_ENDPOINT !== undefined) {
      deployment.set("BROKER_OTLP_TRACES_ENDPOINT", traceEndpoint(env.BROKER_OTLP_TRACES_ENDPOINT));

      if (env.BROKER_OTLP_AUTHORIZATION !== undefined)
        deployment.set(
          "BROKER_OTLP_AUTHORIZATION",
          traceAuthorization(await read("BROKER_OTLP_AUTHORIZATION")),
        );
    } else if (env.BROKER_OTLP_AUTHORIZATION !== undefined) {
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

interface Run {
  /** Sees stdout and stderr as they are forwarded. */
  watch?: (text: string) => void;
  stdin?: Blob;
  /** Captures stdout and stderr instead of forwarding them. */
  capture?: boolean;
}

async function runCommand(
  env: NodeJS.ProcessEnv,
  args: string[],
  { watch, capture, stdin }: Run = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const piped = Boolean(watch || capture);

  const child = Bun.spawn([process.execPath, "run", ...args], {
    cwd: resolve(repository, servicePath),
    env,
    stdin: stdin ?? (capture ? "ignore" : "inherit"),
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

/** The environment Wrangler runs with: Cloudflare account settings, but no broker settings or keys. */
function wranglerEnvironment(
  inherited: NodeJS.ProcessEnv,
  settings: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...inherited };

  for (const name of Object.keys(env)) {
    if (/^(?:BROKER_|CREDENTIAL_|BEACHSIDE_BROKER_)/.test(name)) delete env[name];
  }

  if (settings.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = settings.CLOUDFLARE_API_TOKEN;

  if (settings.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = settings.CLOUDFLARE_ACCOUNT_ID;

  return env;
}

/** Names of the secrets the deployed Worker has, or none when it does not exist yet. */
async function workerSecretNames(env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const { code, stdout, stderr } = await withDeployConfig(undefined, (args) =>
    runCommand(env, ["wrangler", "secret", "list", "--format", "json", ...args], {
      capture: true,
    }),
  );

  if (code !== 0) {
    if (workerNotFound.test(stderr + stdout)) return new Set();
    process.stderr.write(stderr);

    return setupError(
      "Could not read the Worker's secrets. Fix the Wrangler error above and try again",
    );
  }

  try {
    const listed: { name: string }[] = JSON.parse(stdout.slice(stdout.indexOf("[")));

    return new Set(listed.map((secret) => secret.name));
  } catch {
    return setupError("Could not read the Worker's secrets from Wrangler's output");
  }
}

/** The origin Wrangler printed for the deployed Worker. */
function deployedOrigin(output: string, saved?: string): string | undefined {
  const origins = [
    ...Array.from(output.matchAll(/https:\/\/[\w.-]+\.workers\.dev\b/g), ([origin]) => origin),
    ...Array.from(
      output.matchAll(/^\s*([\w.-]+\.[a-z]{2,}) \(custom domain\)\s*$/gim),
      ([, host]) => `https://${host}`,
    ),
  ];

  return origins.find((origin) => saved && URL.parse(saved)?.origin === origin) ?? origins[0];
}

async function deployWrangler(
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
  args: string[],
  savedURL?: string,
): Promise<{ code: number; url?: string }> {
  // Wrangler reads secrets only from a file. It is private and removed as soon as Wrangler exits.
  const directory = mkdtempSync(resolve(tmpdir(), "broker-wrangler-"));

  try {
    const path = resolve(directory, "secrets.json");
    writeFileSync(path, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });

    let raced = false;
    let tail = "";
    let printed = "";

    const watch = (text: string) => {
      tail = (tail + text).slice(-512);
      printed = (printed + text).slice(-16_384);
      raced ||= firstDeployRace.test(tail);
    };

    const code = await withDeployConfig(secrets.BROKER_EMAIL_FROM, async (config) => {
      const command = ["deploy:wrangler", ...args, ...config, "--secrets-file", path];
      let { code } = await runCommand(env, command, { watch });

      if (code !== 0 && raced) {
        // A Worker's first deploy can upload, then fail to read itself back while the Workers API
        // catches up. The upload landed, so one more deploy finishes it.
        console.info("Cloudflare had not registered the new Worker yet. Deploying again.");
        await Bun.sleep(5_000);
        ({ code } = await runCommand(env, command, { watch }));
      }

      return code;
    });

    return { code, url: deployedOrigin(printed, savedURL) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function printKeys(keys: ReturnType<typeof generateKeys>) {
  console.info(
    [
      "",
      "Save these two keys in your password manager now. They are not stored locally and cannot be read back from the Worker.",
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
      "The encryption key is not shown: the Worker holds the only lasting copy.",
    ].join("\n"),
  );
}

/** Saves the deployed origin, reporting rather than failing: the deploy itself has succeeded. */
function recordURL(envPath: string, url: string | undefined): string | undefined {
  if (!url) {
    console.warn("Save the HTTPS origin Wrangler printed as BEACHSIDE_BROKER_URL in .env.deploy.");

    return;
  }

  try {
    const { previous, changed } = saveBrokerURL(envPath, url);

    if (changed)
      console.info(
        previous
          ? `Replaced BEACHSIDE_BROKER_URL ${previous} with ${url} in .env.deploy.`
          : `Saved BEACHSIDE_BROKER_URL=${url} to .env.deploy.`,
      );
  } catch (error) {
    console.warn(
      `${error instanceof CredentialBrokerError ? error.message : "Could not save the URL"}. Save BEACHSIDE_BROKER_URL=${url} in .env.deploy yourself.`,
    );
  }

  return url;
}

async function setup(
  envPath: string,
  inherited: NodeJS.ProcessEnv,
  file: NodeJS.ProcessEnv | undefined,
  settings: NodeJS.ProcessEnv,
  printAnyway: boolean,
): Promise<number> {
  if (!printAnyway && !process.stdout.isTTY)
    return setupError(
      "Setup prints the new admin and issuer keys once, so run it in a terminal. Pass --print-keys to print them anyway",
    );

  if (plaintextKeys(file).length)
    return setupError(
      ".env.deploy holds broker keys from an older setup, so this broker already exists. Update it with bun run deploy",
    );

  const inheritedKeys = keySecrets.filter(
    (name) => inherited[name] && !isSecretReference(inherited[name]),
  );

  if (inheritedKeys.length)
    return setupError(
      `${inheritedKeys.join(", ")} is set in the environment. Setup generates its own keys; unset it, or update an existing broker with bun run deploy`,
    );

  const secrets = await settingSecrets(settings);
  const env = wranglerEnvironment(inherited, settings);
  const workerSecrets = await workerSecretNames(env);
  const existing = keySecrets.filter((name) => workerSecrets.has(name));

  if (existing.length)
    return setupError(
      `The broker Worker already has ${existing.join(", ")}. Setup never replaces keys: update the Worker with bun run deploy`,
    );
  const keys = generateKeys();

  const { code, url } = await deployWrangler(env, { ...secrets, ...keys }, []);

  if (code !== 0) {
    console.error(
      "Deploy failed, so the new keys were discarded. Fix the error above and run bun run deploy:setup again. If setup then says the Worker already has keys, delete the new Worker with `bun run --cwd services/credential-broker wrangler delete` first.",
    );

    return code;
  }

  console.info(`Deployed ${url ?? "the broker"}.`);
  printKeys(keys);
  recordURL(envPath, url);

  return 0;
}

async function setupPlatformKey(
  inherited: NodeJS.ProcessEnv,
  settings: NodeJS.ProcessEnv,
  printAnyway: boolean,
): Promise<number> {
  if (!printAnyway && !process.stdout.isTTY)
    return setupError(
      "Setup prints the platform key once. Run it in a terminal or pass --print-keys",
    );

  const env = wranglerEnvironment(inherited, settings);
  const existing = await workerSecretNames(env);

  if (!existing.has("BROKER_ADMIN_KEY") || !existing.has("BROKER_ENCRYPTION_KEYS"))
    return setupError("Run bun run deploy:setup before setting up the platform key");

  if (existing.has("BROKER_PLATFORM_KEY"))
    return setupError("The Worker already has BROKER_PLATFORM_KEY. Setup never replaces role keys");

  const key = randomKey();

  const { code } = await withDeployConfig(undefined, (config) =>
    runCommand(env, ["wrangler", "secret", "put", "BROKER_PLATFORM_KEY", ...config], {
      stdin: new Blob([key]),
    }),
  );

  if (code === 0)
    console.info(`Save this key in your password manager now. It cannot be read back.

  BROKER_PLATFORM_KEY=${key}`);

  return code;
}

async function deploy() {
  const args = process.argv.slice(2);
  const setupOnly = args[0] === "--setup-only";
  const envPath = resolve(repository, environmentFile);
  const inherited = process.env;

  if (args.length === 1 && ["--help", "-h"].includes(args[0]!))
    return (await runCommand(wranglerEnvironment(inherited, {}), ["deploy:wrangler", ...args]))
      .code;

  if (args.length === 1 && args[0] === "--dry-run") {
    return withDeployConfig(
      emailSender({ ...inherited, ...loadDeploymentFile(envPath) }),
      async (config) =>
        (
          await runCommand(wranglerEnvironment(inherited, {}), [
            "deploy:wrangler",
            "--dry-run",
            ...config,
          ])
        ).code,
    );
  }

  if (
    args.some((argument) => argument === "--secrets-file" || argument.startsWith("--secrets-file="))
  )
    return setupError("Use bun run deploy:wrangler for a manually managed --secrets-file");
  const file = loadDeploymentFile(envPath);
  const settings = { ...inherited, ...file };

  if (setupOnly) {
    const options = args.slice(1);

    if (options.some((option) => !["--print-keys", "--platform-key-only"].includes(option)))
      return setupError("bun run deploy:setup accepts --print-keys and --platform-key-only");

    const printAnyway = options.includes("--print-keys");

    return options.includes("--platform-key-only")
      ? setupPlatformKey(inherited, settings, printAnyway)
      : setup(envPath, inherited, file, settings, printAnyway);
  }

  const plaintext = plaintextKeys(file);

  if (plaintext.length) console.warn(`${plaintextWarning(plaintext)} Deploys never upload keys.`);
  const env = wranglerEnvironment(inherited, settings);
  const dryRun = args.includes("--dry-run");
  const existing = dryRun ? undefined : await workerSecretNames(env);

  if (existing && (!existing.has("BROKER_ADMIN_KEY") || !existing.has("BROKER_ENCRYPTION_KEYS")))
    return setupError(
      "This Worker has no broker keys yet. Create the broker with bun run deploy:setup first",
    );

  const secrets = await settingSecrets(
    settings,
    dryRun || Boolean(existing?.has("BROKER_PLATFORM_KEY")),
  );

  const { code, url } = await deployWrangler(env, secrets, args, settings.BEACHSIDE_BROKER_URL);

  if (code === 0 && !dryRun) {
    recordURL(envPath, url ?? settings.BEACHSIDE_BROKER_URL);
    console.info("Deployed. Check it with `bun run broker status`.");
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
