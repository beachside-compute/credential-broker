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
import { configureDeployment, loadDeploymentFile } from "../scripts/deployment-file";

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
    "src/terminal.ts",
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
    if (command === "whoami") {
      console.log(JSON.stringify({ loggedIn: process.env.SIGNED_IN === "yes" }));
      if (process.env.SIGNED_IN !== "yes") process.exitCode = 1;
    }
    if (command === "login") process.exitCode = Number(process.env.LOGIN_STATUS ?? 0);
    if (command === "deploy") process.exitCode = Number(process.env.DEPLOY_STATUS ?? 0);
  `,
  );

  return {
    service: realpathSync(service),
    command: [process.execPath, join(root, "scripts/deploy.ts")],
  };
}

async function runTerminal(command: string[], answers: string[][], env: NodeJS.ProcessEnv = {}) {
  let output = "";
  let answered = 0;

  const child = Bun.spawn(command, {
    env: { PATH: process.env.PATH, ...env },
    terminal: {
      data(terminal, data) {
        output += Buffer.from(data).toString();
        const prompt = answers[answered];

        if (!prompt || !output.includes(prompt[0])) return;
        answered++;
        terminal.write(`${prompt[1]}\r`);
      },
    },
  });

  const timer = setTimeout(() => child.kill(), 5_000);

  try {
    const status = await child.exited;
    expect(answered).toBe(answers.length);

    return { status, output };
  } finally {
    clearTimeout(timer);
    child.terminal?.close();
  }
}

const confirmKeys = ["Generate broker keys", "y"];

const confirmDeploy = ["deploy now?", "y"];

test("writes a private dotenv file with independent keys and keeps existing bytes", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    const output: string[] = [];
    expect(
      await configureDeployment(
        path,
        async () => "y",
        (message) => output.push(message),
      ),
    ).toBe(true);
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
      expect(output.join("")).not.toContain(key);
    }

    const saved = readFileSync(path, "utf8");
    await expect(
      configureDeployment(
        path,
        async () => {
          throw new Error("unexpected prompt");
        },
        () => {},
      ),
    ).rejects.toThrow("already exists");
    expect(readFileSync(path, "utf8")).toBe(saved);
  }));

test("declining setup, concurrent files, exposed permissions, and symlinks cannot replace keys", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    expect(
      await configureDeployment(
        path,
        async () => "",
        () => {},
      ),
    ).toBe(false);
    expect(existsSync(path)).toBe(false);
    await expect(
      configureDeployment(
        path,
        async () => {
          writeFileSync(path, "OTHER_OPERATOR=keep\n", { mode: 0o600 });

          return "yes";
        },
        () => {},
      ),
    ).rejects.toThrow("Existing files are kept");
    expect(readFileSync(path, "utf8")).toBe("OTHER_OPERATOR=keep\n");
    chmodSync(path, 0o644);
    expect(() => loadDeploymentFile(path)).toThrow("private regular file");
    const target = join(root, "credentials");
    rmSync(path);
    writeFileSync(target, "CLOUDFLARE_API_TOKEN=fixture\n", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => loadDeploymentFile(path)).toThrow("regular file");
  }));

test("a fresh terminal wizard signs in through Wrangler, deploys, redacts output and cleans the secret file", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const deploy = await runTerminal(command, [confirmKeys, confirmDeploy]);
    expect(deploy.status).toBe(0);
    const env = loadDeploymentFile(join(root, ".env.deploy"))!;

    const calls = readFileSync(join(service, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(calls.map((call) => call.command)).toEqual(["whoami", "login", "deploy"]);
    const upload = calls[2];
    expect(upload.cwd).toBe(service);
    expect(upload.args).toEqual(["--secrets-file", upload.path]);
    expect(upload.mode).toBe(0o600);
    expect(existsSync(dirname(upload.path))).toBe(false);
    expect(upload.bindings).toEqual({ ...env, BROKER_CONFIG: '{"workerSecretBindings":[]}' });
    expect(deploy.output).not.toContain(env.BROKER_ADMIN_KEY!);
    expect(deploy.output).not.toContain(env.BROKER_ISSUER_KEY!);
    expect(deploy.output).not.toContain(env.BROKER_ENCRYPTION_KEYS!);
  }));

test("setup-only and declined deployment do not authenticate, and declining a fresh save writes nothing", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const file = join(root, ".env.deploy");
    const unattended = Bun.spawnSync(command, { env: { PATH: process.env.PATH }, stdin: "ignore" });
    expect(unattended.exitCode).toBe(1);
    expect(unattended.stderr.toString()).toContain("needs a terminal");
    expect((await runTerminal(command, [["Generate broker keys", "n"]])).status).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect((await runTerminal(command, [confirmKeys, ["deploy now?", "n"]])).status).toBe(0);
    expect(existsSync(file)).toBe(true);
    rmSync(file);
    expect((await runTerminal([...command, "--setup-only"], [confirmKeys])).status).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(service, "calls.jsonl"))).toBe(false);
  }));

test("reuses saved keys and forwards only validated Worker bindings, even when Wrangler fails", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const file = join(root, ".env.deploy");
    await configureDeployment(
      file,
      async () => "y",
      () => {},
    );
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

test("reuses signed-in Wrangler sessions and leaves keys available after a failed login", async () => {
  await fixture(async (root) => {
    const { service, command } = provisionStub(root);
    expect(
      (await runTerminal(command, [confirmKeys, confirmDeploy], { SIGNED_IN: "yes" })).status,
    ).toBe(0);

    const calls = readFileSync(join(service, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(calls.map((call) => call.command)).toEqual(["whoami", "deploy"]);
  });
  await fixture(async (root) => {
    const { service, command } = provisionStub(root);
    expect(
      (await runTerminal(command, [confirmKeys, confirmDeploy], { LOGIN_STATUS: "17" })).status,
    ).toBe(17);

    const calls = readFileSync(join(service, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(calls.map((call) => call.command)).toEqual(["whoami", "login"]);
    expect(loadDeploymentFile(join(root, ".env.deploy"))?.BROKER_ADMIN_KEY).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });
});

test("help and dry run are configuration-free and existing Alchemy state requires the explicit command", () =>
  fixture(async (root) => {
    const { service, command } = provisionStub(root);
    const path = join(root, ".env.deploy");
    const options = { env: { PATH: process.env.PATH }, stdin: "ignore" } as const;
    expect(Bun.spawnSync([...command, "--help"], options).exitCode).toBe(0);
    expect(Bun.spawnSync([...command, "--dry-run"], options).exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    await configureDeployment(
      path,
      async () => "y",
      () => {},
    );
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
