import { expect, test } from "bun:test";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const adminKey = "private-broker-admin-fixture-0123456789";

test("checkout command runs the Node CLI with the selected HTTPS origin and its protected admin key", async () => {
  const project = resolve(import.meta.dir, "..");
  const root = mkdtempSync(join(tmpdir(), "broker-checkout-cli-"));

  try {
    mkdirSync(join(root, "scripts"));

    for (const file of ["broker.ts", "deployment-file.ts"]) {
      copyFileSync(join(project, "scripts", file), join(root, "scripts", file));
    }

    cpSync(join(project, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(project, "node_modules"), join(root, "node_modules"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { broker: "bun scripts/broker.ts" } }),
    );
    const secretFile = join(root, ".env.deploy");
    const settings = `BROKER_ADMIN_KEY=${adminKey}\n`;
    writeFileSync(secretFile, settings, { mode: 0o600 });
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");

    const certificate = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ]);

    expect(certificate.exitCode).toBe(0);
    const requests: { path: string; authorization: string | null }[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        });

        return Response.json({ integrations: [] });
      },
    });

    try {
      const origin = server.url.origin;

      const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
        const child = Bun.spawn([process.execPath, "run", "broker", ...args], {
          cwd: root,
          env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, ...env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });

        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          Bun.readableStreamToText(child.stdout),
          Bun.readableStreamToText(child.stderr),
        ]);

        expect(stdout).not.toContain(adminKey);
        expect(stderr).not.toContain(adminKey);

        return { status, stdout, stderr };
      };

      const list = ["integration", "list"];
      const unpaired = await run(list, { BEACHSIDE_BROKER_URL: origin });
      expect(unpaired.status).toBe(1);
      expect(unpaired.stderr).toContain("--url");
      expect(requests).toEqual([]);
      const explicit = await run(["--url", origin, ...list]);
      expect(explicit.status, explicit.stderr).toBe(0);
      expect(JSON.parse(explicit.stdout)).toEqual({ integrations: [] });
      writeFileSync(secretFile, `${settings}BEACHSIDE_BROKER_URL=${origin}\n`);
      const saved = await run(list, { BEACHSIDE_BROKER_URL: "https://unrelated.example.invalid" });
      expect(saved.status, saved.stderr).toBe(0);
      expect(requests).toEqual(
        Array.from({ length: 2 }, () => ({
          path: "/v1/admin/integrations",
          authorization: `Bearer ${adminKey}`,
        })),
      );
      expect(readdirSync(join(root, ".cache"))).toEqual([]);
    } finally {
      await server.stop(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
