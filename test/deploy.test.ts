import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
      },
    }),
  );
  writeFileSync(
    join(service, "provision.ts"),
    `
    import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
    const [command, ...args] = process.argv.slice(2);
    if (command === "secret") {
      if (process.env.SECRET_LIST_ERROR) {
        console.error(process.env.SECRET_LIST_ERROR);
        process.exit(1);
      }
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
      inheritedRuntimeSecret: Boolean(process.env.BROKER_ADMIN_KEY || process.env.CREDENTIAL_DECLARED || process.env.BEACHSIDE_BROKER_ADMIN_KEY),
      ...(command === "deploy" && path && { path, mode: statSync(path).mode & 0o777, bindings: JSON.parse(readFileSync(path, "utf8")) }),
      ...(args.includes("--config") && { config: JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8")) }),
    };
    appendFileSync("calls.jsonl", JSON.stringify(record) + "\\n");
    if (command === "deploy") process.exitCode = Number(process.env.DEPLOY_STATUS ?? 0);
    if (command === "deploy" && process.env.BREAK_ENV_FILE) mkdirSync("../../.env.deploy");
    if (command === "deploy" && !args.includes("--dry-run")) console.log("Deployed triggers\\n  " + (process.env.DEPLOY_URL ?? "https://beachside-credential-broker.fixture.workers.dev"));
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

const fixtureURL = "https://beachside-credential-broker.fixture.workers.dev";

function calls(service: string) {
  const path = join(service, "calls.jsonl");

  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function spawn(command: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync(command, { env: { PATH: process.env.PATH, ...env }, stdin: "ignore" });

  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

test("setup deploys fresh keys once, prints the role keys and saves only the URL", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const path = join(root, ".env.deploy");
    const setup = [...command, "--setup-only"];

    const missing = spawn(command);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("bun run deploy:setup");

    // Without a terminal the keys would land in a log, so printing them takes an explicit flag.
    const unattended = spawn(setup);
    expect(unattended.code).toBe(1);
    expect(unattended.stderr).toContain("--print-keys");
    expect(calls(service)).toEqual([]);

    const run = spawn([...setup, "--print-keys"]);
    expect(run.code, run.stderr).toBe(0);
    const [upload] = calls(service);
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

    expect(run.stdout).toContain(`BROKER_ADMIN_KEY=${bindings.BROKER_ADMIN_KEY}`);
    expect(run.stdout).toContain(`BROKER_ISSUER_KEY=${bindings.BROKER_ISSUER_KEY}`);
    expect(run.stdout + run.stderr).not.toContain(encryption);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadDeploymentFile(path)).toEqual({ BEACHSIDE_BROKER_URL: fixtureURL });

    // Setup never replaces a live broker's keys, even when only some of them are on the Worker.
    for (const existing of [deployed, "BROKER_ADMIN_KEY"]) {
      const again = spawn([...setup, "--print-keys"], { WORKER_SECRETS: existing });
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("Setup never replaces keys");
    }

    // Only Wrangler's missing-Worker reply counts as a fresh broker.
    const unreadable = spawn([...setup, "--print-keys"], {
      SECRET_LIST_ERROR: "Authentication error: profile not found.",
    });

    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("Could not read the Worker's secrets");
    expect(calls(service)).toHaveLength(1);
  }));

test("setup prints the keys even when it cannot save the URL", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const run = spawn([...command, "--setup-only", "--print-keys"], { BREAK_ENV_FILE: "1" });
    expect(run.code, run.stderr).toBe(0);
    const [{ bindings }] = calls(service);
    expect(run.stdout).toContain(`BROKER_ADMIN_KEY=${bindings.BROKER_ADMIN_KEY}`);
    expect(run.stderr).toContain(`Save BEACHSIDE_BROKER_URL=${fixtureURL} in .env.deploy yourself`);
  }));

test("setup accepts key references but refuses keys an older setup saved", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const path = join(root, ".env.deploy");
    const setup = [...command, "--setup-only", "--print-keys"];
    writeFileSync(path, "BROKER_ADMIN_KEY=old-plaintext-admin\n", { mode: 0o600 });
    const legacy = spawn(setup);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain("older setup");
    expect(calls(service)).toEqual([]);

    const references = "BROKER_ADMIN_KEY=op://Private/broker/admin\nBROKER_ISSUER_KEY=env:ISSUER\n";
    writeFileSync(path, references);
    const run = spawn(setup);
    expect(run.code, run.stderr).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(`${references}BEACHSIDE_BROKER_URL=${fixtureURL}\n`);
  }));

test("the URL is saved only to a private regular file and must be a broker origin", () =>
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
    rmSync(path);
    expect(() => saveBrokerURL(path, "https://broker.example.com/v1")).toThrow("origin");
    expect(existsSync(path)).toBe(false);
    saveBrokerURL(path, "https://broker.example.com/");
    expect(readFileSync(path, "utf8")).toEndWith(
      "\nBEACHSIDE_BROKER_URL=https://broker.example.com\n",
    );
  }));

test("updates never upload broker keys, resolve setting references and follow the deployed URL", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const file = join(root, ".env.deploy");

    const setting = {
      BEACHSIDE_BROKER_URL: "https://old-broker.example.com",
      BROKER_ADMIN_KEY: "old-plaintext-admin",
      BROKER_ISSUER_KEY: "op://Private/beachside-broker/issuer",
      BROKER_ENCRYPTION_KEYS: '{"v1":"old-plaintext-encryption"}',
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
      BROKER_CONFIG: '{"workerSecretBindings":["CREDENTIAL_DECLARED"]}',
      CREDENTIAL_DECLARED: "env:DECLARED_SOURCE",
      CREDENTIAL_UNUSED: "fake-unused-secret",
      BROKER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces",
      BROKER_OTLP_AUTHORIZATION: "env:COLLECTOR_AUTH",
    };

    writeFileSync(
      file,
      Object.entries(setting)
        .map(([name, value]) => `${name}='${value}'`)
        .join("\n"),
      { mode: 0o600 },
    );

    const run = spawn([...command, "--name", "fixture"], {
      WORKER_SECRETS: deployed,
      DEPLOY_STATUS: "19",
      DECLARED_SOURCE: "fake-declared-secret",
      COLLECTOR_AUTH: "Bearer fake-collector-auth",
      BROKER_ADMIN_KEY: "inherited-should-not-leak",
      BEACHSIDE_BROKER_ADMIN_KEY: "inherited-should-not-leak",
    });

    expect(run.code).toBe(19);
    expect(run.stderr).toContain("BROKER_ADMIN_KEY, BROKER_ENCRYPTION_KEYS in plaintext");
    const [upload] = calls(service);
    expect(upload.cwd).toBe(service);
    expect(upload.args).toEqual(["--name", "fixture", "--secrets-file", upload.path]);
    expect(upload.inheritedRuntimeSecret).toBe(false);
    expect(upload.receivedToken && upload.receivedAccount).toBe(true);
    expect(upload.bindings).toEqual({
      BROKER_CONFIG: setting.BROKER_CONFIG,
      BROKER_OTLP_TRACES_ENDPOINT: setting.BROKER_OTLP_TRACES_ENDPOINT,
      BROKER_OTLP_AUTHORIZATION: "Bearer fake-collector-auth",
      CREDENTIAL_DECLARED: "fake-declared-secret",
    });
    expect(loadDeploymentFile(file)?.BEACHSIDE_BROKER_URL).toBe(setting.BEACHSIDE_BROKER_URL);

    // The broker commands send the file's keys to its URL, so a successful deploy replaces a stale one.
    const deployedRun = spawn(command, {
      WORKER_SECRETS: deployed,
      DECLARED_SOURCE: "x",
      COLLECTOR_AUTH: "Bearer y",
    });

    expect(deployedRun.code, deployedRun.stderr).toBe(0);
    expect(deployedRun.stdout).toContain(
      `Replaced BEACHSIDE_BROKER_URL ${setting.BEACHSIDE_BROKER_URL} with ${fixtureURL}`,
    );
    expect(loadDeploymentFile(file)?.BEACHSIDE_BROKER_URL).toBe(fixtureURL);
  }));

test("help and dry run need no settings or Worker", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    expect(spawn([...command, "--help"]).code).toBe(0);
    expect(spawn([...command, "--dry-run"], { BEACHSIDE_BROKER_ADMIN_KEY: "leak" }).code).toBe(0);
    expect(
      calls(service).map((call) => [call.command, call.args, call.inheritedRuntimeSecret]),
    ).toEqual([
      ["deploy", ["--help"], false],
      ["deploy", ["--dry-run"], false],
    ]);
    expect(existsSync(join(root, ".env.deploy"))).toBe(false);
  }));

test("an email sender adds the send_email binding to that deploy only", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    writeFileSync(join(service, "wrangler.jsonc"), '{\n  // comment\n  "name": "broker",\n}');
    writeFileSync(join(root, ".env.deploy"), "BROKER_EMAIL_FROM=canary@alerts.example.com\n", {
      mode: 0o600,
    });

    const run = spawn(command, { WORKER_SECRETS: deployed });
    expect(run.code, run.stderr).toBe(0);
    const [upload] = calls(service);
    expect(upload.bindings.BROKER_EMAIL_FROM).toBe("canary@alerts.example.com");
    expect(upload.config).toEqual({
      name: "broker",
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["canary@alerts.example.com"] }],
    });
    expect(readdirSync(service).filter((name) => name.startsWith("wrangler.deploy."))).toEqual([]);

    const dryRun = spawn([...command, "--dry-run"]);
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(calls(service)[1].config.send_email).toEqual(upload.config.send_email);

    writeFileSync(join(root, ".env.deploy"), "BROKER_EMAIL_FROM=not-an-address\n");
    expect(spawn(command, { WORKER_SECRETS: deployed }).code).not.toBe(0);
    expect(spawn([...command, "--dry-run"]).code).not.toBe(0);
    expect(calls(service)).toHaveLength(2);
  }));

test("custom domains add custom domain routes to the deploy and dry run", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    writeFileSync(join(service, "wrangler.jsonc"), '{\n  // comment\n  "name": "broker",\n}');
    writeFileSync(
      join(root, ".env.deploy"),
      "BROKER_CUSTOM_DOMAINS=Gateway.Example.sh, broker.example.com,gateway.example.sh\n",
      { mode: 0o600 },
    );

    const run = spawn(command, { WORKER_SECRETS: deployed });
    expect(run.code, run.stderr).toBe(0);
    const [upload] = calls(service);
    expect(upload.config).toEqual({
      name: "broker",
      routes: [
        { pattern: "gateway.example.sh", custom_domain: true },
        { pattern: "broker.example.com", custom_domain: true },
      ],
    });
    expect(upload.bindings.BROKER_CUSTOM_DOMAINS).toBeUndefined();
    expect(readdirSync(service).filter((name) => name.startsWith("wrangler.deploy."))).toEqual([]);

    const dryRun = spawn([...command, "--dry-run"]);
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(calls(service)[1].config.routes).toEqual(upload.config.routes);

    for (const invalid of [
      "https://gateway.example.sh",
      "gateway.example.sh/path",
      "*.example.sh",
    ]) {
      writeFileSync(join(root, ".env.deploy"), `BROKER_CUSTOM_DOMAINS=${invalid}\n`);
      expect(spawn(command, { WORKER_SECRETS: deployed }).code).not.toBe(0);
      expect(spawn([...command, "--dry-run"]).code).not.toBe(0);
    }

    expect(calls(service)).toHaveLength(2);
  }));

test(
  "deploys once more when a first deploy loses Cloudflare's read-back race",
  () =>
    fixture(async (root) => {
      const { service, command } = provisionStub(root);
      const run = spawn([...command, "--setup-only", "--print-keys"], { DEPLOY_RACE: "1" });
      expect(run.code).toBe(0);
      expect(run.stderr).toContain("code: 10007");
      expect(calls(service)).toHaveLength(2);
      expect(calls(service)[1].bindings).toEqual(calls(service)[0].bindings);

      const failed = spawn(command, { WORKER_SECRETS: deployed, DEPLOY_STATUS: "9" });
      expect(failed.code).toBe(9);
      expect(calls(service)).toHaveLength(3);
    }),
  20_000,
);
