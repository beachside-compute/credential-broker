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
import { loadDeploymentFile, saveBrokerURL } from "../scripts/deployment-file";

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
    "src/secret-ref.ts",
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
    if (command === "secret") {
      if (process.env.WORKER_SECRETS === undefined) {
        console.error('Worker "beachside-credential-broker" not found.');
        process.exit(1);
      }
      console.log(JSON.stringify(process.env.WORKER_SECRETS.split(",").filter(Boolean).map((name) => ({ name, type: "secret_text" }))));
      process.exit(0);
    }
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
    if (command === "deploy" && !args.includes("--dry-run")) console.log("Deployed triggers\\n  https://beachside-credential-broker.fixture.workers.dev");
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

const deployed =
  "BROKER_ADMIN_KEY,BROKER_ISSUER_KEY,BROKER_ENCRYPTION_KEYS,BROKER_ENCRYPTION_KEY_VERSION,BROKER_CONFIG";

function calls(service: string) {
  return readFileSync(join(service, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("setup deploys fresh keys once, prints the role keys and saves only the URL", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const path = join(root, ".env.deploy");
    const options = { env: { PATH: process.env.PATH }, stdin: "ignore" } as const;
    const missing = Bun.spawnSync(command, options);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("bun run deploy:setup");
    expect(existsSync(join(service, "calls.jsonl"))).toBe(false);

    const setup = Bun.spawnSync([...command, "--setup-only"], options);
    expect(setup.exitCode, setup.stderr.toString()).toBe(0);
    const [upload] = calls(service);
    expect(upload.command).toBe("deploy");
    expect(upload.mode).toBe(0o600);
    expect(existsSync(dirname(upload.path))).toBe(false);
    const { bindings } = upload;
    expect(Object.keys(bindings).sort()).toEqual(deployed.split(",").sort());
    expect(bindings.BROKER_ENCRYPTION_KEY_VERSION).toBe("v1");
    const encryption = JSON.parse(bindings.BROKER_ENCRYPTION_KEYS).v1;
    const keys = [bindings.BROKER_ADMIN_KEY, bindings.BROKER_ISSUER_KEY, encryption];
    expect(new Set(keys).size).toBe(3);

    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, "base64url").byteLength).toBe(32);
    }

    const printed = setup.stdout.toString();
    expect(printed).toContain(`BROKER_ADMIN_KEY=${bindings.BROKER_ADMIN_KEY}`);
    expect(printed).toContain(`BROKER_ISSUER_KEY=${bindings.BROKER_ISSUER_KEY}`);
    expect(printed + setup.stderr.toString()).not.toContain(encryption);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadDeploymentFile(path)).toEqual({
      BEACHSIDE_BROKER_URL: "https://beachside-credential-broker.fixture.workers.dev",
    });

    // Setup never replaces a live broker's keys, which would orphan its encrypted integrations.
    const again = Bun.spawnSync([...command, "--setup-only"], {
      ...options,
      env: { ...options.env, WORKER_SECRETS: deployed },
    });

    expect(again.exitCode).toBe(1);
    expect(again.stderr.toString()).toContain("already has its keys");
    expect(calls(service)).toHaveLength(1);
  }));

test("setup refuses keys left in .env.deploy by an older setup", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    writeFileSync(join(root, ".env.deploy"), "BROKER_ADMIN_KEY=old-plaintext-admin\n", {
      mode: 0o600,
    });

    const run = Bun.spawnSync([...command, "--setup-only"], {
      env: { PATH: process.env.PATH },
      stdin: "ignore",
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("bun run deploy");
    expect(existsSync(join(service, "calls.jsonl"))).toBe(false);
  }));

test("the URL is saved only to a private regular file", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    writeFileSync(path, "OTHER_OPERATOR=keep\n");
    chmodSync(path, 0o644);
    expect(() => saveBrokerURL(path, "https://broker.example.com")).toThrow("private regular file");
    expect(readFileSync(path, "utf8")).toBe("OTHER_OPERATOR=keep\n");
    const target = join(root, "credentials");
    rmSync(path);
    writeFileSync(target, "CLOUDFLARE_API_TOKEN=fixture\n", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => saveBrokerURL(path, "https://broker.example.com")).toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("CLOUDFLARE_API_TOKEN=fixture\n");
  }));

test("updates never upload broker keys and forward only validated settings, even when Wrangler fails", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const file = join(root, ".env.deploy");

    const setting = {
      BEACHSIDE_BROKER_URL: "https://broker.example.com",
      BROKER_ADMIN_KEY: "old-plaintext-admin",
      BROKER_ISSUER_KEY: "op://Private/beachside-broker/issuer",
      BROKER_ENCRYPTION_KEYS: '{"v1":"old-plaintext-encryption"}',
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
      BROKER_CONFIG: '{"workerSecretBindings":["CREDENTIAL_DECLARED"]}',
      CREDENTIAL_DECLARED: "fake-declared-secret",
      CREDENTIAL_UNUSED: "fake-unused-secret",
      BROKER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces",
      BROKER_OTLP_AUTHORIZATION: "Bearer fake-collector-auth",
    };

    const updated = Object.entries(setting)
      .map(([name, value]) => `${name}='${value}'`)
      .join("\n");

    writeFileSync(file, updated, { mode: 0o600 });

    const run = Bun.spawnSync([...command, "--name", "fixture"], {
      env: {
        PATH: process.env.PATH,
        WORKER_SECRETS: deployed,
        DEPLOY_STATUS: "19",
        BROKER_ADMIN_KEY: "inherited-should-not-leak",
        CREDENTIAL_DECLARED: "inherited-should-not-leak",
        ALCHEMY_PASSWORD: "unrelated-alchemy-password",
      },
      stdin: "ignore",
    });

    expect(run.exitCode).toBe(19);
    expect(run.stderr.toString()).toContain(
      "BROKER_ADMIN_KEY, BROKER_ENCRYPTION_KEYS in plaintext",
    );
    const [upload] = calls(service);
    expect(upload.cwd).toBe(service);
    expect(upload.args).toEqual(["--name", "fixture", "--secrets-file", upload.path]);
    expect(upload.inheritedRuntimeSecret).toBe(false);
    expect(upload.receivedToken && upload.receivedAccount).toBe(true);
    expect(upload.bindings).toEqual({
      BROKER_CONFIG: setting.BROKER_CONFIG,
      BROKER_OTLP_TRACES_ENDPOINT: setting.BROKER_OTLP_TRACES_ENDPOINT,
      BROKER_OTLP_AUTHORIZATION: setting.BROKER_OTLP_AUTHORIZATION,
      CREDENTIAL_DECLARED: setting.CREDENTIAL_DECLARED,
    });
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

    const old =
      'BROKER_ADMIN_KEY=fixture-admin\nBROKER_ENCRYPTION_KEYS=\'{"v1":"fixture"}\'\nBROKER_ENCRYPTION_KEY_VERSION=v1\nALCHEMY_STAGE=production\nALCHEMY_PASSWORD=fixture-existing-alchemy-secret\n';

    writeFileSync(path, old, { mode: 0o600 });
    const rejected = Bun.spawnSync(command, options);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain("Use bun run deploy:alchemy");
    expect(
      Bun.spawnSync([...command, "--alchemy", "--stage", "production"], options).exitCode,
    ).toBe(0);

    expect(calls(service).map((call) => [call.command, call.args])).toEqual([
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

      const run = Bun.spawnSync([...command, "--setup-only"], {
        env: { PATH: process.env.PATH, DEPLOY_RACE: "1" },
        stdin: "ignore",
      });

      expect(run.exitCode).toBe(0);
      expect(run.stderr.toString()).toContain("code: 10007");
      expect(calls(service)).toHaveLength(2);
      expect(calls(service)[1].bindings).toEqual(calls(service)[0].bindings);

      const failed = Bun.spawnSync(command, {
        env: { PATH: process.env.PATH, WORKER_SECRETS: deployed, DEPLOY_STATUS: "9" },
        stdin: "ignore",
      });

      expect(failed.exitCode).toBe(9);
      expect(calls(service)).toHaveLength(3);
    }),
  20_000,
);
