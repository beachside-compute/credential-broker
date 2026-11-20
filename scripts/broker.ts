import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { CredentialBrokerError } from "../src/transport.js";
import { loadDeploymentFile, setupError } from "./deployment-file";

const root = resolve(import.meta.dir, "..");

/** Options that take a value, so their value is never mistaken for the command. */
const valueOptions = new Set(["--url", "--provider", "--ttl", "--label", "--worker-secret"]);

/** The command words, skipping options and their values. */
function commandWords(args: readonly string[]): string[] {
  const words: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;

    if (valueOptions.has(argument)) index++;
    else if (!argument.startsWith("-")) words.push(argument);
  }

  return words;
}

/** Take `--url <origin>` or `--url=<origin>` out of the arguments; the runner resolves the URL. */
function takeURL(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;

    if (argument === "--url") {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) return setupError("Pass the broker origin after --url");
      args.splice(index, 2);

      return value;
    }

    if (argument.startsWith("--url=")) {
      args.splice(index, 1);

      return argument.slice("--url=".length);
    }
  }
}

async function packageVersion(): Promise<string> {
  try {
    const manifest: { version?: string } = await Bun.file(resolve(root, "package.json")).json();

    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function broker() {
  const args = process.argv.slice(2);
  const selectedURL = takeURL(args);
  const [group] = commandWords(args);
  const help = args.includes("--help") || args.includes("-h") || !group;
  const version = args.includes("--version");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BEACHSIDE_BROKER_CLI_PREFIX: "bun run broker",
    BEACHSIDE_BROKER_CLI_VERSION: await packageVersion(),
  };

  const fromEnv = {
    url: env.BEACHSIDE_BROKER_URL,
    admin: env.BEACHSIDE_BROKER_ADMIN_KEY,
    issuer: env.BEACHSIDE_BROKER_ISSUER_KEY,
  };

  delete env.BEACHSIDE_BROKER_URL;
  delete env.BEACHSIDE_BROKER_ADMIN_KEY;
  delete env.BEACHSIDE_BROKER_ISSUER_KEY;
  delete env.BROKER_ADMIN_KEY;
  delete env.BROKER_ISSUER_KEY;

  if (!help && !version) {
    const file = loadDeploymentFile(resolve(root, ".env.deploy"));
    const admin = file?.BROKER_ADMIN_KEY ?? fromEnv.admin;
    const issuer = file?.BROKER_ISSUER_KEY ?? fromEnv.issuer;

    // Grant commands use the issuer key, except `grant list --all`, which reads every grant.
    // `status` reports whichever key is available, preferring the admin key.
    const role =
      group === "grant" && !args.includes("--all")
        ? "issuer"
        : group === "status" && !admin && issuer
          ? "issuer"
          : "admin";

    const key = role === "issuer" ? issuer : admin;

    const keyFromFile =
      (role === "issuer" ? file?.BROKER_ISSUER_KEY : file?.BROKER_ADMIN_KEY) !== undefined;

    // .env.deploy takes precedence for the values it sets. A key from the file is only sent to the
    // file's URL or an explicit --url, never to a URL that happens to be in the environment.
    const url =
      selectedURL ?? file?.BEACHSIDE_BROKER_URL ?? (keyFromFile ? undefined : fromEnv.url);

    if (!url || !key)
      return setupError(
        keyFromFile && fromEnv.url && !url
          ? "The key in .env.deploy is only sent to the BEACHSIDE_BROKER_URL in that file. Add it there, or pass --url"
          : `Run bun run broker --url https://your-broker.example.com <command> with your ${role} key in .env.deploy or the environment`,
      );

    env.BEACHSIDE_BROKER_URL = url;
    env[role === "issuer" ? "BEACHSIDE_BROKER_ISSUER_KEY" : "BEACHSIDE_BROKER_ADMIN_KEY"] = key;
  }

  const node = Bun.which("node");

  if (!node)
    throw new CredentialBrokerError(
      "UNAVAILABLE",
      "Install Node.js 22 or later to run the broker management CLI",
    );
  const cache = resolve(root, ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, "broker-cli-"));

  try {
    const build = await Bun.build({
      entrypoints: [resolve(root, "src/cli.ts")],
      target: "node",
      format: "esm",
      naming: "broker.mjs",
      external: ["@clack/prompts"],
      outdir: directory,
    });

    if (!build.success)
      throw new CredentialBrokerError("UNAVAILABLE", "Could not build the broker management CLI");

    const child = Bun.spawn([node, resolve(directory, "broker.mjs"), ...args], {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    return await child.exited;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await broker();
} catch (error) {
  const known = error instanceof CredentialBrokerError;
  console.error(known ? error.message : "Could not start the broker management CLI");
  // Usage and setup errors exit 2, like the CLI's own; anything else is 1.
  process.exitCode = known && error.code === "INVALID_ARGUMENT" ? 2 : 1;
}
