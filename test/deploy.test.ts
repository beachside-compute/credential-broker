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
import {
  configureDeployment,
  deploymentEnvironment,
  launchDeployment,
  loadDeploymentFile,
} from "../scripts/deploy";

const account = "a".repeat(32);

const token = "fake-cloudflare-provisioning-token";

async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "broker-deploy-"));

  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("writes a private dotenv file with fresh independent keys and never prints credentials", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    const answers = [account, token, "y"];
    const masks: boolean[] = [];
    const output: string[] = [];

    expect(
      await configureDeployment(
        path,
        async (_label, secret = false) => {
          masks.push(secret);

          return answers.shift() ?? "";
        },
        (message) => output.push(message),
      ),
    ).toBe(true);
    expect(masks).toEqual([false, true, false]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const env = loadDeploymentFile(path)!;
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe(account);
    expect(env.CLOUDFLARE_API_TOKEN).toBe(token);
    expect(env.ALCHEMY_STAGE).toBe("production");
    expect(env.BROKER_ENCRYPTION_KEY_VERSION).toBe("v1");

    const keys = [
      env.BROKER_ADMIN_KEY,
      env.BROKER_ISSUER_KEY,
      env.ALCHEMY_PASSWORD,
      JSON.parse(env.BROKER_ENCRYPTION_KEYS ?? "{}").v1,
    ];

    expect(new Set(keys).size).toBe(4);

    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, "base64url").byteLength).toBe(32);
      expect(output.join("")).not.toContain(key);
    }

    expect(output.join("")).not.toContain(token);
    const before = readFileSync(path, "utf8");
    await expect(
      configureDeployment(
        path,
        async () => {
          throw new Error("unexpected prompt");
        },
        () => {},
      ),
    ).rejects.toThrow("already exists");
    expect(readFileSync(path, "utf8")).toBe(before);
  }));

test("declining, invalid input and a concurrent file creation leave the destination untouched", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    const answers = [account, token, ""];

    expect(
      await configureDeployment(
        path,
        async () => answers.shift() ?? "",
        () => {},
      ),
    ).toBe(false);
    expect(existsSync(path)).toBe(false);
    const invalid = [account, `${token}\nALCHEMY_STAGE=invalid`];
    await expect(
      configureDeployment(
        path,
        async () => invalid.shift() ?? "",
        () => {},
      ),
    ).rejects.toThrow("Cloudflare API token");
    expect(existsSync(path)).toBe(false);

    const race = [account, token];
    await expect(
      configureDeployment(
        path,
        async () => {
          const answer = race.shift();

          if (answer) return answer;
          writeFileSync(path, "OTHER_OPERATOR=keep\n", { mode: 0o600 });

          return "yes";
        },
        () => {},
      ),
    ).rejects.toThrow("Existing files are kept");
    expect(readFileSync(path, "utf8")).toBe("OTHER_OPERATOR=keep\n");
  }));

test("rejects an exposed file and a symlink before reading deployment credentials", () =>
  fixture(async (root) => {
    const path = join(root, ".env.deploy");
    const target = join(root, "credentials");
    writeFileSync(target, "CLOUDFLARE_API_TOKEN=fixture\n", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => loadDeploymentFile(path)).toThrow("regular file");
    rmSync(path);
    writeFileSync(path, "CLOUDFLARE_API_TOKEN=fixture\n", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => loadDeploymentFile(path)).toThrow("private regular file");
  }));

test("loads the root deployment file and keeps the existing Alchemy service cwd and arguments", () =>
  fixture(async (root) => {
    const envPath = join(root, ".env.deploy");
    const answers = [account, token, "yes"];
    await configureDeployment(
      envPath,
      async () => answers.shift() ?? "",
      () => {},
    );
    const service = join(root, "services", "credential-broker");
    mkdirSync(service, { recursive: true });
    writeFileSync(
      join(service, ".env"),
      "CLOUDFLARE_API_KEY=workspace-key\nCLOUDFLARE_API_TOKEN=workspace-token\n",
    );
    writeFileSync(
      join(service, "package.json"),
      JSON.stringify({ scripts: { deploy: "bun fixture.ts" } }),
    );
    writeFileSync(
      join(service, "fixture.ts"),
      `
    import { writeFileSync } from "node:fs";
    if (process.env.CLOUDFLARE_API_TOKEN !== ${JSON.stringify(token)} ||
      process.env.CLOUDFLARE_API_KEY ||
      process.env.RETAIN_FIXTURE !== "true" ||
      !JSON.parse(process.env.BROKER_ENCRYPTION_KEYS ?? "{}").v1) process.exit(2);
    writeFileSync("result.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
  `,
    );
    const file = loadDeploymentFile(envPath)!;

    const env = deploymentEnvironment(
      {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "stale-token",
        CLOUDFLARE_API_KEY: "legacy-key",
        RETAIN_FIXTURE: "true",
      },
      file,
    );

    expect(await launchDeployment(root, env, ["--stage", "fixture"])).toBe(0);
    expect(JSON.parse(readFileSync(join(service, "result.json"), "utf8"))).toEqual({
      cwd: realpathSync(service),
      args: ["--stage", "fixture"],
    });
  }));

test("the Bun terminal wizard masks the token and exits after declining deployment", () =>
  fixture(async (root) => {
    for (const file of ["scripts/deploy.ts", "src/terminal.ts", "src/transport.ts"]) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(import.meta.dir, "..", file), target);
    }

    const command = [process.execPath, join(root, "scripts/deploy.ts")];
    const env = { PATH: process.env.PATH };
    const nonInteractive = Bun.spawnSync(command, { env, stdin: "ignore" });
    expect(nonInteractive.exitCode).toBe(1);
    expect(nonInteractive.stderr.toString()).toContain("needs a terminal");
    const path = join(root, ".env.deploy");
    expect(existsSync(path)).toBe(false);

    const prompts = [
      ["Cloudflare account ID:", account],
      ["Cloudflare API token:", token],
      ["Save .env.deploy", "y"],
      ["Deploy to Cloudflare now?", "n"],
    ];

    let output = "";
    let answered = 0;

    const child = Bun.spawn(command, {
      env,
      terminal: {
        data(terminal, data) {
          output += Buffer.from(data).toString();
          const prompt = prompts[answered];

          if (!prompt || !output.includes(prompt[0])) return;
          answered++;
          terminal.write(`${prompt[1]}\r`);
        },
      },
    });

    const timer = setTimeout(() => child.kill(), 3_000);

    try {
      expect(await child.exited).toBe(0);
      expect(answered).toBe(prompts.length);
      expect(output).not.toContain(token);
      expect(loadDeploymentFile(path)?.CLOUDFLARE_API_TOKEN).toBe(token);
    } finally {
      clearTimeout(timer);
      child.terminal?.close();
    }
  }));
