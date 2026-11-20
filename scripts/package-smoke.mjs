import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const temporary = await mkdtemp(join(tmpdir(), "beachside-credential-client-pack-"));

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const types = `
import { createCredentialBroker, createCredentialBrokerAdmin } from "@beachside/credential-client";
import type { BrokerEndpoint, BrokerIntegrationCredential, SandboxGrant } from "@beachside/credential-client";

const url = "https://broker.example.invalid";
const apiKey = "fixture_credential_broker_control_key";
const issuer = createCredentialBroker({ url, auth: { apiKey } });
const admin = createCredentialBrokerAdmin({ url, apiKey });
const credential: BrokerIntegrationCredential = { source: "encrypted-store", value: "fixture" };
await admin.integrations.create({ id: "model", kind: "openai", credential });
const endpoint: BrokerEndpoint = {
  baseURL: "https://api.example.com/v1",
  headers: [{ name: "authorization", secret: true, prefix: "Bearer " }],
};
await admin.integrations.create({ id: "gateway", kind: "http", endpoint, credential: {
  source: "encrypted-store", values: { authorization: "fixture" },
} });
const controller = new AbortController();
const grant: SandboxGrant = await issuer.sandbox({ openai: "model", endpoints: [
  { integration: "gateway", baseURLEnv: "GATEWAY_URL", apiKeyEnv: "GATEWAY_TOKEN" },
] }).acquire(controller.signal);
await grant.revoke(controller.signal);
`;

try {
  const [packed] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", temporary], root),
  );

  assert.equal(packed.name, "@beachside/credential-client", "Incorrect package identity");
  assert.ok(packed.files.some(({ path }) => path === "dist/index.d.ts"));
  assert.ok(packed.files.some(({ path }) => path === "dist/cli.js"));
  assert.ok(
    packed.files.every(
      ({ path }) =>
        path.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(path),
    ),
    "Unexpected files in the client archive",
  );

  const archive = join(temporary, packed.filename);

  for (const installer of ["npm", "bun"]) {
    const directory = join(temporary, installer);
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "packed-health", private: true, type: "module" }),
    );
    await writeFile(join(directory, "types.mts"), types);
    await copyFile(
      join(import.meta.dirname, "credential-client-packed.mjs"),
      join(directory, "client.mjs"),
    );
    await copyFile(
      join(import.meta.dirname, "credential-client-cli-packed.mjs"),
      join(directory, "cli.mjs"),
    );

    const install =
      installer === "npm"
        ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive]
        : ["add", "--ignore-scripts", archive];

    run(installer, install, directory);

    const manifest = JSON.parse(
      await readFile(
        join(directory, "node_modules/@beachside/credential-client/package.json"),
        "utf8",
      ),
    );

    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
    run(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--strict",
        "--noEmit",
        "--target",
        "es2022",
        "--module",
        "NodeNext",
        "types.mts",
      ],
      directory,
    );

    const runtime = installer === "npm" ? process.execPath : "bun";
    process.stdout.write(run(runtime, ["client.mjs"], directory));
    process.stdout.write(run(runtime, ["cli.mjs"], directory));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
