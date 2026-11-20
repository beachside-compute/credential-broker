import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "beachside-broker-cli-"));

const certPath = join(temp, "cert.pem");

const keyPath = join(temp, "key.pem");

const command = join(process.cwd(), "node_modules/.bin/beachside-broker");

const adminKey = "fixture_separate_admin_control_key";

const initial = "fixture-upstream-first-value";

const replacement = "fixture-upstream-replacement-value";

const metadata = {
  id: "github-work",
  kind: "github",
  enabled: true,
  credentialSource: "encrypted-store",
  credentialVersion: 1,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
};

const routes = [];

let service;

async function handle(request, response) {
  const route = `${request.method} ${request.url}`;
  routes.push(route);
  assert.equal(request.headers.authorization, `Bearer ${adminKey}`);
  const chunks = [];

  for await (const chunk of request) chunks.push(chunk);

  const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;

  const json = (status, value) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

  switch (route) {
    case "POST /v1/admin/integrations":
      if (routes.filter((seen) => seen === route).length > 1) {
        return json(409, { credential: initial, apiKey: adminKey });
      }

      assert.deepEqual(input, {
        id: metadata.id,
        kind: "github",
        credential: { source: "encrypted-store", value: initial },
      });

      return json(201, { ...metadata, hiddenFixtureField: initial });
    case "PUT /v1/admin/integrations/github-work/credential":
      assert.deepEqual(input, { source: "encrypted-store", value: replacement });

      return json(200, { ...metadata, credentialVersion: 2, hiddenFixtureField: replacement });
    case "PUT /v1/admin/issuer-permissions":
      assert.deepEqual(input, { integrations: [metadata.id] });

      return json(200, input);
    default:
      return json(404, {});
  }
}

const errors = [];

try {
  const cert = spawnSync("openssl", [
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
    keyPath,
    "-out",
    certPath,
  ]);

  assert.equal(cert.status, 0, "Could not generate the loopback fixture certificate");
  service = createServer(
    {
      key: await readFile(keyPath),
      cert: await readFile(certPath),
    },
    (request, response) => {
      void handle(request, response).catch((error) => {
        errors.push(error);
        response.writeHead(500).end();
      });
    },
  );
  service.listen(0, "127.0.0.1");
  await once(service, "listening");

  const env = {
    PATH: process.env.PATH,
    NODE_EXTRA_CA_CERTS: certPath,
    BEACHSIDE_BROKER_URL: `https://127.0.0.1:${service.address().port}`,
    BEACHSIDE_BROKER_ADMIN_KEY: adminKey,
  };

  const run = (args, input) =>
    new Promise((resolve, reject) => {
      const [file, commandArgs] = process.versions.bun
        ? [process.execPath, [command, ...args]]
        : [command, args];

      const child = execFile(file, commandArgs, { env, timeout: 5000 }, (error, stdout, stderr) => {
        if (error && !Number.isInteger(error.code)) reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      });

      child.stdin.on("error", reject);
      child.stdin.end(input);
    });

  const safe = ({ stdout, stderr }) => {
    for (const value of [initial, replacement, adminKey])
      assert.ok(!stdout.includes(value) && !stderr.includes(value), "CLI disclosed a credential");
  };

  const verify = async (args, expected, input) => {
    const result = await run(args, input);
    safe(result);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  };

  const create = ["integration", "create", "github-work", "--provider", "github", "--secret-stdin"];
  await verify(create, metadata, `${initial}\n`);
  await verify(
    ["integration", "rotate", "github-work", "--secret-stdin"],
    {
      ...metadata,
      credentialVersion: 2,
    },
    `${replacement}\r\n`,
  );
  await verify(["issuer", "set", "github-work"], { integrations: ["github-work"] });
  const conflict = await run(create, `${initial}\n`);
  safe(conflict);
  assert.equal(conflict.code, 1);
  assert.equal(conflict.stdout, "");
  assert.match(conflict.stderr, /^CONFLICT /);

  const invalid = await run(["integration", "rotate", "github-work", "--secret", initial]);
  safe(invalid);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.deepEqual(routes, [
    "POST /v1/admin/integrations",
    "PUT /v1/admin/integrations/github-work/credential",
    "PUT /v1/admin/issuer-permissions",
    "POST /v1/admin/integrations",
  ]);
  assert.deepEqual(errors, []);

  console.log(
    "Packed broker CLI created, rotated, and authorized a runtime integration over loopback TLS",
  );
} finally {
  if (service) await new Promise((resolve) => service.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
