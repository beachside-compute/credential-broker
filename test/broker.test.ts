import { expect, test } from "bun:test";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const adminKey = "private-broker-admin-fixture-0123456789";

const issuerKey = "private-broker-issuer-fixture-123456789";

const grant = {
  id: "de07c688-48d2-4073-bb20-c6e5c2893f19",
  token: `bsg_${"a".repeat(64)}`,
  expiresAt: "2026-11-20T00:05:00.000Z",
  integrations: ["openrouter"],
};

test("checkout command runs the Node CLI with the selected HTTPS origin and keys referenced from .env.deploy", async () => {
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
      JSON.stringify({ version: "9.9.9-test", scripts: { broker: "bun scripts/broker.ts" } }),
    );
    // A stand-in 1Password CLI, so keys in .env.deploy can be references.
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, "bin/op"),
      `#!/bin/sh\ncase "$3" in\n  op://Private/broker/admin) printf %s ${adminKey} ;;\n  op://Private/broker/issuer) printf %s ${issuerKey} ;;\n  *) echo "no item $3" >&2; exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const PATH = `${join(root, "bin")}:${process.env.PATH}`;
    const secretFile = join(root, ".env.deploy");
    const settings = "BROKER_ADMIN_KEY=op://Private/broker/admin\n";
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
    const upstreamKey = "fixture-only-openrouter-key";

    const endpoint = {
      baseURL: "https://openrouter.ai/api/v1",
      headers: [{ name: "authorization", secret: true, prefix: "Bearer " }],
    };

    const metadata = {
      id: "openrouter",
      kind: "http",
      enabled: true,
      endpoint,
      credentialSource: "encrypted-store",
      credentialVersion: 1,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    };

    const requests: { path: string; authorization: string | null }[] = [];
    const grantRequests: object[] = [];
    const renewRequests: object[] = [];

    const summary = {
      id: grant.id,
      integrations: ["openrouter"],
      label: "box web",
      createdAt: "2026-11-20T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      requests: 3,
      lastUsedAt: null,
    };

    const limits = { maxGrantTtlSeconds: 604_800 };

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const authorization = request.headers.get("authorization");
        requests.push({ path, authorization });

        if (path === "/v1/status")
          return authorization === `Bearer ${adminKey}`
            ? Response.json({
                apiVersion: 2,
                role: "admin",
                limits,
                counts: { integrations: 1, issuable: 1, activeGrants: 1 },
              })
            : Response.json({ apiVersion: 2, role: "issuer", limits });

        if (path.startsWith("/v1/grants")) {
          expect(authorization).toBe(`Bearer ${issuerKey}`);

          if (request.method === "DELETE" && path === `/v1/grants/${grant.id}`)
            return new Response(null, { status: 204 });

          if (request.method === "GET" && path === "/v1/grants")
            return Response.json({ grants: [summary] });

          if (request.method === "POST" && path === `/v1/grants/${grant.id}/renew`) {
            renewRequests.push(await request.json());

            return Response.json(summary);
          }

          expect(path).toBe("/v1/grants");
          expect(request.method).toBe("POST");
          grantRequests.push(await request.json());

          return Response.json(grant, { status: 201 });
        }

        expect(authorization).toBe(`Bearer ${adminKey}`);

        if (request.method === "PUT" && path === "/v1/admin/issuer-permissions/openrouter")
          return Response.json({ integrations: ["openrouter"] });

        if (request.method === "DELETE" && path === "/v1/admin/issuer-permissions/openrouter")
          return Response.json({ integrations: [] });

        if (path === "/v1/admin/grants")
          return Response.json({ grants: [{ ...summary, owner: "broker-api-key" }] });

        if (path === "/v1/admin/config")
          return Response.json({
            githubActions: {
              audience: "beachside-broker",
              workflows: [{ repository: "acme/app" }],
            },
            workerSecretBindings: 0,
            issuerKey: true,
          });

        if (request.method === "POST") {
          expect(await request.json()).toEqual({
            id: "openrouter",
            kind: "http",
            endpoint,
            credential: { source: "encrypted-store", values: { authorization: upstreamKey } },
          });

          return Response.json(metadata, { status: 201 });
        }

        return Response.json({ integrations: [] });
      },
    });

    try {
      const origin = server.url.origin;

      const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
        const child = Bun.spawn([process.execPath, "run", "broker", ...args], {
          cwd: root,
          env: { PATH, NODE_EXTRA_CA_CERTS: cert, ...env },
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
        expect(stdout).not.toContain(issuerKey);
        expect(stderr).not.toContain(issuerKey);

        return { status, stdout, stderr };
      };

      // --version needs neither a URL nor a key, and reports the checkout's version.
      for (const version of [["--version"], ["--version", "--json"]]) {
        const printed = await run(version);
        expect(printed.status, printed.stderr).toBe(0);
        expect(printed.stdout).toContain("9.9.9-test");
      }

      const list = ["integration", "list", "--json"];
      // A key from .env.deploy is never sent to a URL that only the environment names.
      const unpaired = await run(list, { BEACHSIDE_BROKER_URL: origin });
      expect(unpaired.status).toBe(2);
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
      const human = await run(["integration", "list"]);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain(
        "No integrations yet. Add one with `bun run broker integration setup`.",
      );
      requests.length = 0;

      for (const json of [false, true]) {
        const prompts = [
          ["Choose a provider", "\r"],
          ["Enter for openrouter", "\r"],
          ["Provider API key", `${upstreamKey}\r`],
          ["Create openrouter", "\r"],
        ];

        const stdoutFile = join(root, "setup-stdout");
        let transcript = "";
        let answered = 0;

        const child = Bun.spawn(
          [
            "/bin/sh",
            "-c",
            'exec "$@" > "$FIXTURE_STDOUT"',
            "fixture",
            process.execPath,
            "run",
            "broker",
            "integration",
            "setup",
            ...(json ? ["--json"] : []),
          ],
          {
            cwd: root,
            env: { PATH, NODE_EXTRA_CA_CERTS: cert, FIXTURE_STDOUT: stdoutFile },
            terminal: {
              cols: 110,
              data(terminal, bytes) {
                transcript += Buffer.from(bytes).toString();
                const prompt = prompts[answered];

                if (!prompt || !transcript.includes(prompt[0])) return;
                answered++;
                terminal.write(prompt[1]);
              },
            },
          },
        );

        const timeout = setTimeout(() => child.kill(), 4_000);

        try {
          expect(await child.exited).toBe(0);
          expect(answered).toBe(prompts.length);
          const stdout = readFileSync(stdoutFile, "utf8");
          expect(transcript).not.toContain(upstreamKey);
          expect(stdout).not.toContain(upstreamKey);
          expect(transcript).not.toContain("broker.sandbox");

          if (json) {
            expect(JSON.parse(stdout)).toEqual({ ...metadata, issuable: true });
            expect(transcript).not.toContain("Created integration openrouter.");
          } else {
            expect(stdout).toBe("");
            expect(transcript).toContain("Created integration openrouter.");
            expect(transcript).toContain("The issuer can now mint grants for openrouter");
            expect(transcript).toContain("bun run broker grant issue openrouter");
          }
        } finally {
          clearTimeout(timeout);
          child.terminal?.close();
        }
      }

      const issue = ["grant", "issue", "openrouter"];
      const beforeGrants = requests.length;
      const missingIssuer = await run(issue, { BEACHSIDE_BROKER_ADMIN_KEY: adminKey });
      expect(missingIssuer.status).toBe(2);
      expect(missingIssuer.stderr).toContain("issuer key");
      expect(requests).toHaveLength(beforeGrants);
      writeFileSync(
        secretFile,
        `${settings}BEACHSIDE_BROKER_URL=${origin}\nBROKER_ISSUER_KEY=op://Private/broker/issuer\n`,
      );

      const issued = await run(["--url", origin, ...issue, "--json"], {
        BEACHSIDE_BROKER_ADMIN_KEY: adminKey,
      });

      expect(issued.status, issued.stderr).toBe(0);
      expect(JSON.parse(issued.stdout)).toEqual({
        ...grant,
        gatewayUrls: { openrouter: `${origin}/gateway/openrouter` },
      });
      const raw = await run([...issue, "--ttl", "60", "--token"]);
      expect(raw.status, raw.stderr).toBe(0);
      expect(raw.stdout).toBe(`${grant.token}\n`);
      const weekly = await run([...issue, "--ttl", "7d", "--label", "box web"]);
      expect(weekly.status, weekly.stderr).toBe(0);
      expect(weekly.stdout).toContain(`base url  openrouter: ${origin}/gateway/openrouter`);
      expect(weekly.stdout).toContain(`bun run broker grant revoke ${grant.id}`);
      expect(grantRequests).toEqual([
        { integrations: ["openrouter"], ttlSeconds: 900 },
        { integrations: ["openrouter"], ttlSeconds: 60 },
        { integrations: ["openrouter"], ttlSeconds: 604_800, label: "box web" },
      ]);
      const revoked = await run(["grant", "revoke", grant.id, "--json"]);
      expect(revoked.status, revoked.stderr).toBe(0);
      expect(JSON.parse(revoked.stdout)).toEqual({ revoked: true, id: grant.id });
      expect(requests.at(-1)).toEqual({
        path: `/v1/grants/${grant.id}`,
        authorization: `Bearer ${issuerKey}`,
      });

      // Option values are never mistaken for the command: this is a grant command.
      const listed = await run(["--json", "--url", origin, "grant", "list"]);
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual({ grants: [summary] });
      const listedText = await run(["grant", "list"]);
      expect(listedText.stdout).toContain("LAST USED");
      expect(listedText.stdout).toContain("never");
      const all = await run(["grant", "list", "--all", "--json"]);
      expect(all.status, all.stderr).toBe(0);
      expect(JSON.parse(all.stdout)).toEqual({ grants: [{ ...summary, owner: "broker-api-key" }] });
      expect(requests.at(-1)).toEqual({
        path: "/v1/admin/grants",
        authorization: `Bearer ${adminKey}`,
      });
      const renewed = await run(["grant", "renew", grant.id, "--ttl", "7d", "--json"]);
      expect(renewed.status, renewed.stderr).toBe(0);
      expect(renewRequests).toEqual([{ ttlSeconds: 604_800 }]);
      const status = await run(["status", "--json"]);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ role: "admin" });
      const config = await run(["config", "show"]);
      expect(config.status, config.stderr).toBe(0);
      expect(config.stdout).toContain("audience beachside-broker");
      expect(config.stdout).toContain("- (-): -");
      const allowed = await run(["issuer", "allow", "openrouter", "--json"]);
      expect(JSON.parse(allowed.stdout)).toEqual({ integrations: ["openrouter"] });
      const denied = await run(["issuer", "deny", "openrouter", "--json"]);
      expect(JSON.parse(denied.stdout)).toEqual({ integrations: [] });
      const beforeInvalid = requests.length;

      for (const ttl of ["0", "604801", "8d", "5.5", "1e3"]) {
        const invalid = await run([...issue, "--ttl", ttl]);
        expect(invalid.status).toBe(2);
        expect(invalid.stderr).toContain("--ttl must be 1s to 7d");
      }

      writeFileSync(secretFile, `BEACHSIDE_BROKER_URL=${origin}\nBROKER_ISSUER_KEY=${issuerKey}\n`);
      const missingAdmin = await run(list, { BEACHSIDE_BROKER_ISSUER_KEY: issuerKey });
      expect(missingAdmin.status).toBe(2);
      expect(missingAdmin.stderr).toContain("admin key");
      expect(missingAdmin.stderr).toContain("BROKER_ISSUER_KEY in plaintext");
      expect(requests).toHaveLength(beforeInvalid);
      // With only an issuer key, status reports the issuer role instead of asking for the admin key.
      const issuerStatus = await run(["status", "--json"]);
      expect(issuerStatus.status, issuerStatus.stderr).toBe(0);
      expect(JSON.parse(issuerStatus.stdout)).toMatchObject({ role: "issuer" });
      expect(requests.at(-1)).toEqual({ path: "/v1/status", authorization: `Bearer ${issuerKey}` });

      expect(readdirSync(join(root, ".cache"))).toEqual([]);
    } finally {
      await server.stop(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
