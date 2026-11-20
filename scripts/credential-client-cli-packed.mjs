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

const longest = "x".repeat(4096);

const metadata = {
  id: "github-work",
  kind: "github",
  enabled: true,
  credentialSource: "encrypted-store",
  credentialVersion: 1,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
};

const endpoint = {
  baseURL: "https://upstream.example.com/v1",
  headers: [
    { name: "authorization", secret: true, prefix: "Bearer " },
    { name: "x-tenant", value: "fixture" },
  ],
};

const httpMetadata = { ...metadata, id: "api-work", kind: "http", endpoint };

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
      if (input.kind === "http") {
        assert.deepEqual(input, {
          id: httpMetadata.id,
          kind: "http",
          endpoint,
          credential: { source: "encrypted-store", values: { authorization: initial } },
        });

        return json(201, { ...httpMetadata, hiddenFixtureField: initial });
      }

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
      assert.ok(input.value === replacement || input.value === longest);
      assert.deepEqual(input, { source: "encrypted-store", value: input.value });
      const credentialVersion = input.value === longest ? 3 : 2;

      return json(200, { ...metadata, credentialVersion, hiddenFixtureField: input.value });
    case "PUT /v1/admin/integrations/api-work/credential":
      assert.deepEqual(input, {
        source: "encrypted-store",
        values: { authorization: replacement },
      });

      return json(200, { ...httpMetadata, credentialVersion: 2, hiddenFixtureField: replacement });
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
    for (const value of [initial, replacement, longest, adminKey])
      assert.ok(!stdout.includes(value) && !stderr.includes(value), "CLI disclosed a credential");
  };

  const verify = async (args, expected, input) => {
    const result = await run([...args, "--json"], input);
    safe(result);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  };

  const create = ["integration", "create", "github-work", "--provider", "github", "--secret-stdin"];
  await verify(create, { ...metadata, issuable: false }, `${initial}\n`);
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
  assert.match(conflict.stderr, /^CONFLICT: /);

  const createHttp = ["integration", "create", "api-work", "--provider", "http", "--config-stdin"];
  await verify(
    createHttp,
    { ...httpMetadata, issuable: false },
    JSON.stringify({
      endpoint,
      credential: { source: "encrypted-store", values: { authorization: initial } },
    }),
  );
  await verify(
    ["integration", "rotate", "api-work", "--credentials-stdin"],
    {
      ...httpMetadata,
      credentialVersion: 2,
    },
    JSON.stringify({ authorization: replacement }),
  );

  const rotate = ["integration", "rotate", "github-work", "--secret-stdin"];

  for (const suffix of ["", "\n", "\r\n"]) {
    await verify(rotate, { ...metadata, credentialVersion: 3 }, longest + suffix);
  }

  const invalidOptions = [
    { args: ["integration", "setup"], message: "Integration setup needs a terminal" },
    { args: createHttp, input: `{ "credential": "${initial}`, message: "Expected a JSON object" },
    {
      args: [...createHttp, "--secret-stdin"],
      input: initial,
      message: "HTTP integrations take only --config-stdin",
    },
    { args: ["integration", "list", `--${initial}`], message: "Invalid command options" },
    { args: ["configuration", "show"], message: "Unknown command" },
    {
      args: ["integration", "rotate", "github-work", "--secret", initial],
      message: "Invalid command options",
    },
    {
      args: ["integration", "rotate", "github-work", "--worker-secret"],
      message: "Invalid command options",
    },
    {
      args: [...rotate, "--provider", "github"],
      message: "--provider is not accepted by integration rotate",
    },
    {
      args: [...rotate, "--worker-secret", "CREDENTIAL_GITHUB"],
      message: "Select exactly one credential source",
    },
    {
      args: ["integration", "list", "--secret-stdin"],
      message: "--secret-stdin is not accepted by integration list",
    },
    {
      args: ["issuer", "show", "--worker-secret", "CREDENTIAL_GITHUB"],
      message: "--worker-secret is not accepted by issuer show",
    },
    { args: rotate, input: `${longest}x\n`, message: "Credential on stdin exceeds 4096 bytes" },
    { args: rotate, input: `${longest}x`, message: "Credential on stdin exceeds 4096 bytes" },
  ];

  for (const { args, input, message } of invalidOptions) {
    const invalid = await run(args, input);
    safe(invalid);
    assert.equal(invalid.code, 2);
    assert.equal(invalid.stdout, "");
    assert.ok(invalid.stderr.startsWith(`INVALID_ARGUMENT: ${message}`), invalid.stderr);
  }

  assert.deepEqual(routes, [
    "POST /v1/admin/integrations",
    "PUT /v1/admin/integrations/github-work/credential",
    "PUT /v1/admin/issuer-permissions",
    "POST /v1/admin/integrations",
    "POST /v1/admin/integrations",
    "PUT /v1/admin/integrations/api-work/credential",
    "PUT /v1/admin/integrations/github-work/credential",
    "PUT /v1/admin/integrations/github-work/credential",
    "PUT /v1/admin/integrations/github-work/credential",
  ]);
  assert.deepEqual(errors, []);

  console.log(
    "Packed broker CLI created, rotated, and authorized a runtime integration over loopback TLS",
  );
} finally {
  if (service) await new Promise((resolve) => service.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
