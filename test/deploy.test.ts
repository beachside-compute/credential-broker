import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateDeploymentFile, loadDeploymentFile } from "../scripts/deployment-file";

const token = "fake-cloudflare-provisioning-token";

const account = "a".repeat(32);

async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "broker-deploy-"));

  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function provisionStub(root: string) {
  for (const file of [
    "scripts/deploy.ts",
    "scripts/deployment-file.ts",
    "src/transport.ts",
    "src/endpoint.ts",
  ]) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(import.meta.dir, "..", file), target);
  }

  const service = join(root, "services/credential-broker");
  mkdirSync(service, { recursive: true });
  symlinkSync(join(import.meta.dir, "../services/credential-broker/src"), join(service, "src"));
  symlinkSync(
    join(import.meta.dir, "../services/credential-broker/node_modules"),
    join(service, "node_modules"),
  );
  writeFileSync(
    join(service, "package.json"),
    JSON.stringify({
      scripts: {
        wrangler: "bun provision.ts",
        "deploy:wrangler": "bun provision.ts deploy",
        deploy: "bun provision.ts alchemy",
      },
    }),
  );
  writeFileSync(
    join(service, "provision.ts"),
    `
    import { appendFileSync, readFileSync, statSync } from "node:fs";
    const [command, ...args] = process.argv.slice(2);
    const fileIndex = args.indexOf("--secrets-file");
    const path = fileIndex < 0 ? undefined : args[fileIndex + 1];
    const record = {
      command, args, cwd: process.cwd(),
      receivedToken: process.env.CLOUDFLARE_API_TOKEN === ${JSON.stringify(token)},
      receivedAccount: process.env.CLOUDFLARE_ACCOUNT_ID === ${JSON.stringify(account)},
      inheritedRuntimeSecret: Boolean(process.env.BROKER_ADMIN_KEY || process.env.CREDENTIAL_DECLARED),
      ...(command === "deploy" && path && { path, mode: statSync(path).mode & 0o777, bindings: JSON.parse(readFileSync(path, "utf8")) }),
    };
    appendFileSync("calls.jsonl", JSON.stringify(record) + "\\n");
    if (command === "deploy") process.exitCode = Number(process.env.DEPLOY_STATUS ?? 0);
    if (command === "deploy" && process.env.DEPLOY_RACE && readFileSync("calls.jsonl", "utf8").trim().split("\\n").length === 1) {
      console.error("This Worker does not exist on your account. [code: 10007]");
      process.exitCode = 1;
    }
  `,
  );

  return {
    service: realpathSync(service),
    command: [process.execPath, join(root, "scripts/deploy.ts")],
  };
}

test("setup creates independent private keys without a terminal or Wrangler and keeps the file on repeat", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const path = join(root, ".env.deploy");
    const options = { env: { PATH: process.env.PATH }, stdin: "ignore" } as const;
    const missing = Bun.spawnSync(command, options);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("bun run deploy:setup");
    expect(existsSync(path)).toBe(false);

    const generated = Bun.spawnSync([...command, "--setup-only"], options);
    expect(generated.exitCode).toBe(0);
    expect(generated.stdout.toString()).toContain("Saved .env.deploy");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const env = loadDeploymentFile(path)!;
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.ALCHEMY_PASSWORD).toBeUndefined();
    expect(env.BROKER_ENCRYPTION_KEY_VERSION).toBe("v1");

    const keys = [
      env.BROKER_ADMIN_KEY,
      env.BROKER_ISSUER_KEY,
      JSON.parse(env.BROKER_ENCRYPTION_KEYS ?? "{}").v1,
    ];

    expect(new Set(keys).size).toBe(3);

    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, "base64url").byteLength).toBe(32);
      expect(generated.stdout.toString()).not.toContain(key);
      expect(generated.stderr.toString()).not.toContain(key);
    }

    const saved = readFileSync(path, "utf8");
    const reuse = Bun.spawnSync([...command, "--setup-only"], options);
    expect(reuse.exitCode).toBe(0);
    expect(reuse.stdout.toString()).toContain("Keeping the existing .env.deploy");
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(existsSync(join(service, "calls.jsonl"))).toBe(false);
  }));

test("setup refuses to use exposed files or symlinks", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    writeFileSync(path, "OTHER_OPERATOR=keep\n");
    chmodSync(path, 0o644);
    expect(() => generateDeploymentFile(path)).toThrow("private regular file");
    expect(readFileSync(path, "utf8")).toBe("OTHER_OPERATOR=keep\n");
    const target = join(root, "credentials");
    rmSync(path);
    writeFileSync(target, "CLOUDFLARE_API_TOKEN=fixture\n", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => generateDeploymentFile(path)).toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("CLOUDFLARE_API_TOKEN=fixture\n");
  }));

test("reuses saved keys and forwards only validated Worker bindings, even when Wrangler fails", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const file = join(root, ".env.deploy");
    generateDeploymentFile(file);
    const initial = loadDeploymentFile(file)!;

    const setting = {
      ...initial,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
      BROKER_CONFIG: '{"workerSecretBindings":["CREDENTIAL_DECLARED"]}',
      CREDENTIAL_DECLARED: "fake-declared-secret",
      CREDENTIAL_UNUSED: "fake-unused-secret",
      BROKER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces",
      BROKER_OTLP_AUTHORIZATION: "Bearer fake-collector-auth",
      BROKER_ENCRYPTION_KEY_VERSION: "second",
      BROKER_ENCRYPTION_KEYS: JSON.stringify({
        second: JSON.parse(initial.BROKER_ENCRYPTION_KEYS!).v1,
      }),
    };

    const updated = Object.entries(setting)
      .map(([name, value]) => `${name}='${value}'`)
      .join("\n");

    writeFileSync(file, updated);

    const run = Bun.spawnSync([...command, "--name", "fixture"], {
      env: {
        PATH: process.env.PATH,
        DEPLOY_STATUS: "19",
        BROKER_ADMIN_KEY: "inherited-should-not-leak",
        CREDENTIAL_DECLARED: "inherited-should-not-leak",
        ALCHEMY_PASSWORD: "unrelated-alchemy-password",
      },
      stdin: "ignore",
    });

    expect(run.exitCode).toBe(19);
    const upload = JSON.parse(readFileSync(join(service, "calls.jsonl"), "utf8"));
    expect(upload.command).toBe("deploy");
    expect(upload.cwd).toBe(service);
    expect(upload.mode).toBe(0o600);
    expect(upload.args).toEqual(["--name", "fixture", "--secrets-file", upload.path]);
    expect(upload.inheritedRuntimeSecret).toBe(false);
    expect(upload.receivedToken && upload.receivedAccount).toBe(true);
    expect(upload.bindings).toEqual({
      BROKER_ADMIN_KEY: initial.BROKER_ADMIN_KEY,
      BROKER_ISSUER_KEY: initial.BROKER_ISSUER_KEY,
      BROKER_ENCRYPTION_KEYS: setting.BROKER_ENCRYPTION_KEYS,
      BROKER_ENCRYPTION_KEY_VERSION: "second",
      BROKER_CONFIG: setting.BROKER_CONFIG,
      BROKER_OTLP_TRACES_ENDPOINT: setting.BROKER_OTLP_TRACES_ENDPOINT,
      BROKER_OTLP_AUTHORIZATION: setting.BROKER_OTLP_AUTHORIZATION,
      CREDENTIAL_DECLARED: setting.CREDENTIAL_DECLARED,
    });
    expect(existsSync(dirname(upload.path))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(updated);
  }));

test("help and dry run are configuration-free and existing Alchemy state requires the explicit command", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const path = join(root, ".env.deploy");
    const options = { env: { PATH: process.env.PATH }, stdin: "ignore" } as const;
    expect(Bun.spawnSync([...command, "--help"], options).exitCode).toBe(0);
    expect(Bun.spawnSync([...command, "--dry-run"], options).exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    generateDeploymentFile(path);
    const old = `${readFileSync(path, "utf8")}ALCHEMY_STAGE=production\nALCHEMY_PASSWORD=fixture-existing-alchemy-secret\n`;
    writeFileSync(path, old);
    const rejected = Bun.spawnSync(command, options);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain("Use bun run deploy:alchemy");
    expect(
      Bun.spawnSync([...command, "--alchemy", "--stage", "production"], options).exitCode,
    ).toBe(0);

    const calls = readFileSync(join(service, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ["deploy", ["--help"]],
      ["deploy", ["--dry-run"]],
      ["alchemy", ["--stage", "production"]],
    ]);
    expect(readFileSync(path, "utf8")).toBe(old);
  }));

test(
  "deploys once more when a first deploy loses Cloudflare's read-back race",
  () =>
    fixture(async (root) => {
      const { service, command } = provisionStub(root);
      generateDeploymentFile(join(root, ".env.deploy"));

      const run = Bun.spawnSync(command, {
        env: { PATH: process.env.PATH, DEPLOY_RACE: "1" },
        stdin: "ignore",
      });

      expect(run.exitCode).toBe(0);
      expect(run.stderr.toString()).toContain("code: 10007");
      const calls = readFileSync(join(service, "calls.jsonl"), "utf8").trim().split("\n");
      expect(calls).toHaveLength(2);

      const failed = Bun.spawnSync(command, {
        env: { PATH: process.env.PATH, DEPLOY_STATUS: "9" },
        stdin: "ignore",
      });

      expect(failed.exitCode).toBe(9);
      expect(readFileSync(join(service, "calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    }),
  20_000,
);
