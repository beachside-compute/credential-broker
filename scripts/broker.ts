import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { CredentialBrokerError } from "../src/transport.js";
import { loadDeploymentFile, setupError } from "./deployment-file";

const root = resolve(import.meta.dir, "..");

async function broker() {
  const args = process.argv.slice(2);
  let selectedURL: string | undefined;

  if (args[0] === "--url") {
    selectedURL = args[1];

    if (!selectedURL || selectedURL.startsWith("--"))
      return setupError("Pass the broker HTTPS origin after --url");
    args.splice(0, 2);
  }

  const env = { ...process.env };

  if (args.length && !args.includes("--help") && !args.includes("-h")) {
    if (selectedURL || !env.BEACHSIDE_BROKER_URL || !env.BEACHSIDE_BROKER_ADMIN_KEY) {
      const file = loadDeploymentFile(resolve(root, ".env.deploy"));
      env.BEACHSIDE_BROKER_ADMIN_KEY =
        file?.BROKER_ADMIN_KEY ?? (selectedURL ? env.BEACHSIDE_BROKER_ADMIN_KEY : undefined);
      env.BEACHSIDE_BROKER_URL = selectedURL ?? file?.BEACHSIDE_BROKER_URL;
    }

    if (!env.BEACHSIDE_BROKER_URL || !env.BEACHSIDE_BROKER_ADMIN_KEY)
      return setupError(
        "Run bun run broker --url https://your-broker.example.com <command> with your admin key in .env.deploy or the environment",
      );
  } else {
    delete env.BEACHSIDE_BROKER_ADMIN_KEY;
  }

  const node = Bun.which("node");

  if (!node) return setupError("Install Node.js 22 or later to run the broker management CLI");
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

    if (!build.success) return setupError("Could not build the broker management CLI");

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
  console.error(
    error instanceof CredentialBrokerError
      ? error.message
      : "Could not start the broker management CLI",
  );
  process.exitCode = 1;
}
