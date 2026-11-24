import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ListenOptions, Server } from "node:net";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import type { V4MiniflareOptions } from "miniflare";
import { z } from "zod";
import {
  createCredentialBroker,
  createCredentialBrokerAdmin,
  CredentialBrokerError,
} from "../../../src/index";
import { requireApiKey } from "../../../src/transport";
import { assertSeparateRoleKeys } from "../src/auth";
import { isBrokerApiKey, matchesKey } from "../src/auth/api-key";
import { parseConfig } from "../src/config";
import {
  encryptedStoreSource,
  encryptionKeyring,
  sealCredential,
} from "../src/credentials/sources/encrypted-store";
import type { CredentialInput } from "../src/credentials/source";
import type { IntegrationKind } from "../src/integrations/types";
import { workerSecretSource } from "../src/credentials/sources/worker-secret";
import { tokenHash } from "../src/grants/tokens";
import { endpointHeaders, endpointResponseHeaders } from "../src/proxy/forward";

const execute = promisify(execFile);

const apiKey = "orchestration-fixture-key-1234567890";

const adminKey = "administration-fixture-key-1234567890";

const rootKeyA = Buffer.alloc(32, 42).toString("base64url");

const rootKeyB = Buffer.alloc(32, 73).toString("base64url");

const encryptionKeys = JSON.stringify({ first: rootKeyA, second: rootKeyB });

const issuer = "https://token.actions.githubusercontent.com";

const audience = "https://broker.test/github-actions";

const secret = {
  github: "github_upstream_fixture_key",
  githubSecondary: "github_secondary_fixture_key",
  openai: "openai_upstream_fixture_key",
  anthropic: "anthropic_upstream_fixture_key",
  openrouter: "openrouter_upstream_fixture_key",
};

const kinds = ["github", "openai", "anthropic", "openrouter"] as const;

const defaultNames = [...kinds, "github-secondary"];

const policy = {
  repositoryId: "100",
  repositoryOwnerId: "200",
  repository: "beachside-compute/fixture",
  ref: "refs/heads/main",
  workflowRef: "beachside-compute/fixture/.github/workflows/review.yml@refs/heads/main",
  event: "pull_request_target",
  integrations: ["github"],
};

const reusablePolicy = {
  ...policy,
  event: "workflow_dispatch",
  jobWorkflowRef: "beachside-compute/automation/.github/workflows/shared.yml@refs/heads/main",
};

const config = {
  workerSecretBindings: [
    ...kinds.map((kind) => `CREDENTIAL_${kind.toUpperCase()}`),
    "CREDENTIAL_MISSING",
  ],
  githubActions: { audience, workflows: [policy, reusablePolicy] },
  limits: { openai: { concurrentRequests: 3 }, retired: { requestsPerMinute: 10 } },
};

const claims = {
  repository_id: policy.repositoryId,
  repository_owner_id: policy.repositoryOwnerId,
  repository: policy.repository,
  ref: policy.ref,
  workflow_ref: policy.workflowRef,
  job_workflow_ref: policy.workflowRef,
  event_name: policy.event,
  run_id: "300",
};

const grantSchema = z.object({
  id: z.uuid(),
  token: z.string().regex(/^bsg_[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
});

const keys = await generateKeyPair("RS256");

const wrongKeys = await generateKeyPair("RS256");

const jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture" };

const seen: { url: URL; method: string; headers: Headers; body: string }[] = [];

const gitAuthorizations: string[] = [];

let runtime: Miniflare;

let gitRoot: string;

let sendStreamTail: (() => void) | undefined;

async function buildWorker() {
  const result = await build({
    entryPoints: [`${import.meta.dirname}/../../src/index.ts`],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    define: {
      "navigator.userAgent": '"Cloudflare-Workers"',
      "process.env.NODE_ENV": '"undefined"',
    },
    external: ["cloudflare:*"],
    loader: { ".sql": "text" },
  });

  return result.outputFiles[0].text;
}

const options: V4MiniflareOptions = {
  name: "broker",
  modules: true,
  script: await buildWorker(),
  compatibilityDate: "2026-09-25",
  unsafeInspectDurableObjects: true,
  durableObjects: {
    REGISTRY: { className: "GrantRegistry", useSQLite: true },
  },
  email: { send_email: [{ name: "EMAIL", allowed_sender_addresses: ["canary@alerts.test"] }] },
  bindings: {
    BROKER_EMAIL_FROM: "canary@alerts.test",
    BROKER_ADMIN_KEY: adminKey,
    BROKER_ISSUER_KEY: apiKey,
    BROKER_ENCRYPTION_KEYS: encryptionKeys,
    BROKER_ENCRYPTION_KEY_VERSION: "first",
    BROKER_CONFIG: JSON.stringify(config),
    CREDENTIAL_GITHUB: secret.github,
    CREDENTIAL_OPENAI: secret.openai,
    CREDENTIAL_ANTHROPIC: secret.anthropic,
    CREDENTIAL_OPENROUTER: secret.openrouter,
  },
  async outboundService(request) {
    const url = new URL(request.url);

    if (url.href === `${issuer}/.well-known/jwks`) {
      return RuntimeResponse.json({ keys: [jwk] });
    }

    if (url.hostname === "external.invalid") {
      throw new Error("Outbound fixture made an unexpected request");
    }

    if (url.hostname === "github.com") {
      const authorization = request.headers.get("authorization");
      assert.ok(authorization);
      gitAuthorizations.push(authorization);

      return gitHttpBackend(
        url,
        request.method,
        request.headers.get("content-type"),
        await request.arrayBuffer(),
      );
    }

    seen.push({
      url,
      method: request.method,
      headers: new Headers([...request.headers]),
      body: await request.text(),
    });

    if (url.hostname === "upstream.example.com") {
      if (url.pathname.endsWith("/stream")) return sseFixture();

      if (url.pathname.endsWith("/redirect")) {
        return new RuntimeResponse(null, {
          status: 302,
          headers: { location: `${url.origin}/outside` },
        });
      }

      return RuntimeResponse.json(
        { fixture: true },
        {
          headers: {
            "x-page-count": "2",
            "x-reflected-credential": request.headers.get("authorization") ?? "",
            "cf-aig-authorization": "remove-by-name",
            "set-cookie": "untrusted=response-cookie",
          },
        },
      );
    }

    if (url.hostname === "api.openai.com" && url.pathname === "/v1/chat/completions") {
      return sseFixture();
    }

    if (url.pathname === "/repos/org/demo/issues/99") {
      return new RuntimeResponse(null, {
        status: 307,
        headers: { location: "https://api.github.com/repos/org/demo/issues/42" },
      });
    }

    if (url.pathname === "/repos/org/moved/issues") {
      return new RuntimeResponse(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/123/issues" },
      });
    }

    if (url.pathname === "/repos/org/moved") {
      return new RuntimeResponse(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/123" },
      });
    }

    if (url.pathname === "/repos/org/redirect") {
      return new RuntimeResponse(null, {
        status: 302,
        headers: { location: "https://external.invalid/credential-collector" },
      });
    }

    if (url.pathname === "/repos/org/demo") {
      return RuntimeResponse.json({ full_name: "org/demo" });
    }

    if (url.pathname === "/repositories/123/issues") {
      if (url.searchParams.get("page") === "2") return RuntimeResponse.json([{ number: 42 }]);

      return RuntimeResponse.json([{ number: 41 }], {
        headers: { link: '<https://api.github.com/repositories/123/issues?page=2>; rel="next"' },
      });
    }

    if (url.pathname === "/repos/org/demo/issues" && request.method === "POST") {
      return RuntimeResponse.json({ number: 42 }, { status: 201 });
    }

    if (url.pathname === "/graphql") {
      const { body } = seen.at(-1)!;
      const query = z.object({ query: z.string() }).parse(JSON.parse(body)).query;

      return graphqlFixture(query);
    }

    return RuntimeResponse.json({ fixture: true });
  },
};

before(async () => {
  gitRoot = await mkdtemp(join(tmpdir(), "beachside-broker-"));
  runtime = startRuntime();
  await seedIntegrations();
});

after(async () => {
  await runtime?.dispose();

  if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
});

function admin(path: string, method = "GET", body?: string, authority = adminKey) {
  return runtime.dispatchFetch(`https://broker.test/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${authority}`, "content-type": "application/json" },
    body,
  });
}

async function createIntegration(id: string, kind: IntegrationKind, credential: CredentialInput) {
  const response = await admin("/integrations", "POST", JSON.stringify({ id, kind, credential }));
  assert.equal(response.status, 201);

  return response.json();
}

async function eligible(integrations: string[]) {
  const response = await admin("/issuer-permissions", "PUT", JSON.stringify({ integrations }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { integrations: [...integrations].sort() });
}

async function seedIntegrations() {
  for (const kind of kinds) {
    await createIntegration(kind, kind, {
      source: "worker-secret",
      binding: `CREDENTIAL_${kind.toUpperCase()}`,
    });
  }

  await createIntegration("github-secondary", "github", {
    source: "encrypted-store",
    value: secret.githubSecondary,
  });
  await eligible(defaultNames);
}

async function issue(integrations: string[], authority = apiKey, ttlSeconds = 60) {
  return runtime.dispatchFetch("https://broker.test/v1/grants", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authority}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ integrations, ttlSeconds }),
  });
}

async function grant(integrations: string[], authority = apiKey, ttlSeconds = 60) {
  const response = await issue(integrations, authority, ttlSeconds);
  assert.equal(response.status, 201);

  return grantSchema.parse(await response.json());
}

function access(path: string, token: string, method = "GET", body?: string) {
  return runtime.dispatchFetch(`https://broker.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body,
    redirect: "manual",
  });
}

async function githubToken(
  overrides: Partial<typeof claims> = {},
  aud = audience,
  expiration = "5m",
  key = keys.privateKey,
) {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setSubject("repo:beachside-compute/fixture:pull_request")
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(key);
}

describe("credential broker running in workerd", () => {
  test("issues only with control authentication, persists a digest and enforces expiry/revocation", async () => {
    assert.equal((await issue(["openai"], "wrong-key")).status, 401);
    assert.equal((await issue(["openai"], "z".repeat(32))).status, 401);
    assert.equal((await issue(["unknown"])).status, 403);
    assert.equal((await issue(["openai", "openai"])).status, 400);
    assert.equal((await issue(["openai"], apiKey, 604_801)).status, 400);

    const record = await grant(["openai"]);
    assert.equal((await issue(["openai"], record.token)).status, 401);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    const stored = await storage.exec("SELECT * FROM grants WHERE id = ?", record.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].hash, await tokenHash(record.token));
    assert.ok(!JSON.stringify(stored).includes(record.token));

    for (const value of Object.values(secret)) assert.ok(!JSON.stringify(stored).includes(value));

    await runtime.unsafeEvictDurableObject("broker", "GrantRegistry", { name: "grant-registry" });
    const response = await access("/gateway/openai/v1/models", record.token);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal((await access("/gateway/openrouter/v1/models", record.token)).status, 403);

    const deniedRevoke = await access(`/v1/grants/${record.id}`, record.token, "DELETE");
    assert.equal(deniedRevoke.status, 401);
    assert.equal((await access(`/v1/grants/${record.id}`, apiKey, "DELETE")).status, 204);
    assert.equal((await access(`/v1/grants/${record.id}`, apiKey, "DELETE")).status, 204);
    assert.equal((await access("/gateway/openai/v1/models", record.token)).status, 401);
    assert.deepEqual(await storage.exec("SELECT id FROM leases WHERE grant_id = ?", record.id), []);

    const expiring = await grant(["openai"], apiKey, 1);
    const expiresIn = Date.parse(expiring.expiresAt) - Date.now();
    await delay(Math.max(0, expiresIn) + 20);
    assert.equal((await access("/gateway/openai/v1/models", expiring.token)).status, 401);

    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await storage.exec("SELECT id FROM grants WHERE id = ?", expiring.id);

      if (!rows.length) break;
      await delay(20);
    }

    assert.deepEqual(await storage.exec("SELECT id FROM grants WHERE id = ?", expiring.id), []);
  });

  test("verifies GitHub Actions signature and direct-workflow claims through the JWKS endpoint", async () => {
    const authority = await githubToken();
    const record = await grant(["github"], authority);
    await grant(["github"], await githubToken({ job_workflow_ref: undefined }));
    assert.equal((await issue(["openai"], authority)).status, 403);
    const otherRun = await githubToken({ run_id: "301" });
    assert.equal((await access(`/v1/grants/${record.id}`, otherRun, "DELETE")).status, 204);
    const response = await access("/api/v3/user", record.token);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal((await access(`/v1/grants/${record.id}`, authority, "DELETE")).status, 204);

    const invalid = await Promise.all([
      githubToken({}, "wrong-audience"),
      githubToken({}, audience, "-5m"),
      githubToken({}, audience, "5m", wrongKeys.privateKey),
      githubToken({ repository_id: "101" }),
      githubToken({ repository_owner_id: "201" }),
      githubToken({ repository: "fork/fixture" }),
      githubToken({
        workflow_ref: "beachside-compute/fixture/.github/workflows/other.yml@refs/heads/main",
      }),
      githubToken({ job_workflow_ref: reusablePolicy.jobWorkflowRef }),
      githubToken({ event_name: "pull_request" }),
      githubToken({ ref: "refs/pull/1/merge" }),
    ]);

    for (const token of invalid) assert.equal((await issue(["github"], token)).status, 401);
  });

  test("requires an exact signed job_workflow_ref for a configured reusable workflow", async () => {
    const event = { event_name: reusablePolicy.event };

    const authority = await githubToken({
      ...event,
      job_workflow_ref: reusablePolicy.jobWorkflowRef,
    });

    await grant(["github"], authority);

    for (const ref of [undefined, policy.workflowRef, `${reusablePolicy.jobWorkflowRef}-wrong`]) {
      const wrong = await githubToken({ ...event, job_workflow_ref: ref });
      assert.equal((await issue(["github"], wrong)).status, 401);
    }
  });

  test("injects only at fixed upstreams and rejects unsafe query, redirect and routes", async () => {
    const issued = await grant([...kinds]);

    for (const kind of ["openai", "anthropic", "openrouter"] as const) {
      const response = await runtime.dispatchFetch(
        `https://broker.test/gateway/${kind}/v1/models`,
        {
          headers: {
            [kind === "anthropic" ? "x-api-key" : "authorization"]:
              kind === "anthropic" ? issued.token : `Bearer ${issued.token}`,
            cookie: "session=must-not-forward",
            "proxy-authorization": "Basic Zm9vOmJhcg==",
            "x-forwarded-host": "evil.invalid",
            "openai-organization": "untrusted-org",
            traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
            baggage: "irrelevant=field",
          },
        },
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { fixture: true });
      const last = seen.at(-1)!;
      assert.equal(last.url.hostname, kind === "openrouter" ? "openrouter.ai" : `api.${kind}.com`);
      assert.equal(last.url.pathname, kind === "openrouter" ? "/api/v1/models" : "/v1/models");
      assert.equal(
        last.headers.get(kind === "anthropic" ? "x-api-key" : "authorization"),
        kind === "anthropic" ? secret[kind] : `Bearer ${secret[kind]}`,
      );

      for (const name of [
        "cookie",
        "proxy-authorization",
        "x-forwarded-host",
        "openai-organization",
        "traceparent",
        "baggage",
      ]) {
        assert.equal(last.headers.has(name), false);
      }

      assert.ok(!JSON.stringify([...last.headers]).includes(issued.token));
    }

    const moved = await access("/api/v3/repos/org/moved", issued.token);
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get("location"), "/api/v3/repositories/123");
    assert.equal((await access("/api/v3/repos/org/redirect", issued.token)).status, 502);
    assert.equal((await access("/api/v3/user/keys", issued.token)).status, 404);
    assert.equal((await access("/api/v3/user?access_token=placeholder", issued.token)).status, 404);
    assert.equal((await access("/gateway/openrouter/v1/keys", issued.token)).status, 404);

    const beforeRef = seen.length;

    for (const endpoint of ["branches", "commits"]) {
      for (const ref of ["feature/login", "feature%2Flogin"]) {
        assert.equal(
          (await access(`/api/v3/repos/org/demo/${endpoint}/${ref}`, issued.token)).status,
          404,
        );
      }
    }

    assert.equal(seen.length, beforeRef);

    const beforeWrite = seen.length;

    const blockedWrite = await access(
      "/api/v3/repos/org/demo/issues/99",
      issued.token,
      "PATCH",
      "{}",
    );

    assert.equal(blockedWrite.status, 502);
    assert.deepEqual(
      seen.slice(beforeWrite).map(({ method, url }) => [method, url.pathname]),
      [["PATCH", "/repos/org/demo/issues/99"]],
    );
  });
});

test("reserves the grant-token format outside the broker API-key parser", async () => {
  const reserved = `bsg_${"0".repeat(64)}`;
  assert.equal(isBrokerApiKey(apiKey), true);
  assert.equal(isBrokerApiKey(reserved), false);
  assert.equal(await matchesKey(reserved, reserved), false);
});

test("reuses only the last validated operator configuration", () => {
  const raw = JSON.stringify(config);
  const original = parseConfig(raw);
  assert.equal(parseConfig(raw), original);

  const changedRaw = JSON.stringify({
    ...config,
    githubActions: { ...config.githubActions, audience: "new-audience" },
  });

  const changed = parseConfig(changedRaw);
  assert.equal(changed.githubActions?.audience, "new-audience");
  assert.throws(
    () => parseConfig(JSON.stringify({ integrations: [] })),
    /Invalid broker configuration/,
  );
  assert.equal(parseConfig(changedRaw), changed);
  assert.notEqual(parseConfig(raw), original);
});

test("reads Worker secret data properties and getters and rejects unavailable bindings", async () => {
  const reference = { source: "worker-secret", binding: "CREDENTIAL_MODEL" } as const;
  const plain = workerSecretSource({ CREDENTIAL_MODEL: "plain-fixture-value" });
  assert.deepEqual(await plain.resolve(reference), { value: "plain-fixture-value" });

  let value = "first-fixture-value";

  const getter = workerSecretSource({
    get CREDENTIAL_MODEL() {
      return value;
    },
  });

  assert.deepEqual(await getter.resolve(reference), { value });

  value = "rotated-fixture-value";
  assert.deepEqual(await getter.resolve(reference), { value });
  assert.equal(await workerSecretSource({}).resolve(reference), undefined);
  assert.equal(
    await workerSecretSource({ CREDENTIAL_MODEL: "invalid\nvalue" }).resolve(reference),
    undefined,
  );
});

async function gitHttpBackend(
  url: URL,
  method: string,
  contentType: string | null,
  body: ArrayBuffer,
) {
  const task = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: gitRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      REQUEST_METHOD: method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_LENGTH: String(body.byteLength),
      CONTENT_TYPE: contentType ?? "",
      REMOTE_USER: "fixture",
      REMOTE_ADDR: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const completion = once(task, "close");
  task.stdin.end(Buffer.from(body));

  const [output, stderr, [exitCode]] = await Promise.all([
    buffer(task.stdout),
    buffer(task.stderr),
    completion,
  ]);

  if (exitCode !== 0) throw new Error(`git http-backend fixture failed: ${stderr}`);
  const stdout = Buffer.from(output);
  const headerEnd = stdout.indexOf("\r\n\r\n");

  if (headerEnd < 0) throw new Error("git http-backend did not return CGI headers");

  const headers = new Headers();
  let status = 200;

  for (const line of stdout.subarray(0, headerEnd).toString().split("\r\n")) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();

    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value, 10);
    } else {
      headers.append(name, value);
    }
  }

  return new RuntimeResponse(stdout.subarray(headerEnd + 4), { status, headers: [...headers] });
}

async function cli(args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const [command, ...parameters] = args;

  const { stdout } = await execute(command, parameters, {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_TELEMETRY: "off",
      GH_PROMPT_DISABLED: "1",
      ...env,
    },
  });

  return stdout;
}

test("git clone and push use the GitHub smart HTTPS gateway", async () => {
  const root = join(gitRoot, "org");
  await mkdir(root);
  await cli(["git", "init", "--bare", "--initial-branch=main", "demo.git"], root);
  const cert = join(gitRoot, "certificate.pem");
  const key = join(gitRoot, "key.pem");
  await cli(
    [
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
    ],
    gitRoot,
  );

  const relay = createHttpsServer(
    { cert: await readFile(cert), key: await readFile(key) },
    relayHttp,
  );

  await listen(relay, { host: "127.0.0.1", port: 0 });

  try {
    const { port } = z.object({ port: z.number() }).parse(relay.address());
    const brokerUrl = `https://127.0.0.1:${port}`;
    const issued = await clientGrant(brokerUrl);
    const startGit = gitAuthorizations.length;
    const remote = "https://github.com/org/demo";
    const gitEnv = { ...issued.env, GIT_SSL_CAINFO: cert };
    await cli(["git", "clone", remote, "work"], gitRoot, gitEnv);
    const checkout = join(gitRoot, "work");
    await writeFile(join(checkout, "fixture.txt"), "broker git fixture\n");
    await cli(["git", "add", "fixture.txt"], checkout, gitEnv);
    await cli(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "Fixture",
      ],
      checkout,
      gitEnv,
    );
    await cli(["git", "push", "origin", "HEAD:main"], checkout, gitEnv);
    await cli(["git", "clone", remote, "readback"], gitRoot, gitEnv);
    assert.equal(
      await readFile(join(gitRoot, "readback", "fixture.txt"), "utf8"),
      "broker git fixture\n",
    );
    assert.equal(await cli(["git", "remote", "get-url", "origin"], checkout), `${remote}\n`);
    const first = gitAuthorizations.slice(startGit);
    assert.ok(first.length > 0);
    assert.ok(first.every((value) => value === `Basic ${btoa(`x-access-token:${secret.github}`)}`));

    const secondary = await clientGrant(brokerUrl, "github-secondary");
    const startSecondary = gitAuthorizations.length;
    await cli(["git", "clone", remote, "secondary"], gitRoot, {
      ...secondary.env,
      GIT_SSL_CAINFO: cert,
    });
    const second = gitAuthorizations.slice(startSecondary);
    assert.ok(second.length > 0);
    assert.ok(
      second.every(
        (value) => value === `Basic ${btoa(`x-access-token:${secret.githubSecondary}`)}`,
      ),
    );
  } finally {
    await relay[Symbol.asyncDispose]();
  }
});

test("gh calls GitHub REST and GraphQL through the broker host", async () => {
  const issued = await clientGrant("https://broker.test");
  const ghConfig = join(gitRoot, "gh-config");
  await mkdir(ghConfig);
  const socket = join(gitRoot, "gh.sock");
  await writeFile(
    join(ghConfig, "config.yml"),
    `http_unix_socket: ${socket}\ntelemetry: disabled\n`,
  );
  const relay = createServer(relayHttp);
  await listen(relay, { path: socket });

  const env = {
    ...issued.env,
    GH_CONFIG_DIR: ghConfig,
  };

  try {
    assert.equal(
      await cli(["gh", "api", "repos/org/demo", "--jq", ".full_name"], gitRoot, env),
      "org/demo\n",
    );
    assert.equal(
      await cli(
        [
          "gh",
          "api",
          "repos/org/demo/issues",
          "-X",
          "POST",
          "-f",
          "title=Fixture",
          "--jq",
          ".number",
        ],
        gitRoot,
        env,
      ),
      "42\n",
    );
    assert.equal(
      await cli(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=query { viewer { login } }",
          "--jq",
          ".data.viewer.login",
        ],
        gitRoot,
        env,
      ),
      "fixture\n",
    );
    assert.equal(
      await cli(
        ["gh", "repo", "view", "org/demo", "--json", "name", "--jq", ".name"],
        gitRoot,
        env,
      ),
      "demo\n",
    );
    assert.equal(
      await cli(
        ["gh", "issue", "list", "--repo", "org/demo", "--json", "number", "--jq", ".[0].number"],
        gitRoot,
        env,
      ),
      "42\n",
    );
    assert.equal(
      await cli(
        ["gh", "pr", "list", "--repo", "org/demo", "--json", "number", "--jq", ".[0].number"],
        gitRoot,
        env,
      ),
      "43\n",
    );
    assert.equal(
      await cli(
        ["gh", "issue", "create", "--repo", "org/demo", "--title", "Fixture", "--body", "Fixture"],
        gitRoot,
        env,
      ),
      "https://github.com/org/demo/issues/42\n",
    );
    assert.equal(
      await cli(
        [
          "gh",
          "pr",
          "create",
          "--repo",
          "org/demo",
          "--base",
          "main",
          "--head",
          "feature",
          "--title",
          "Fixture",
          "--body",
          "Fixture",
        ],
        gitRoot,
        env,
      ),
      "https://github.com/org/demo/pull/43\n",
    );
    assert.equal(
      await cli(
        ["gh", "pr", "comment", "43", "--repo", "org/demo", "--body", "Fixture"],
        gitRoot,
        env,
      ),
      "https://github.com/org/demo/pull/43#issuecomment-1\n",
    );
    assert.equal(
      await cli(
        ["gh", "api", "repos/org/moved/issues", "--paginate", "--jq", ".[].number"],
        gitRoot,
        env,
      ),
      "41\n42\n",
    );
    assert.equal(seen.at(-1)?.headers.get("authorization"), `Bearer ${secret.github}`);

    const secondary = await clientGrant("https://broker.test", "github-secondary");
    assert.equal(
      await cli(["gh", "api", "repos/org/demo", "--jq", ".full_name"], gitRoot, {
        ...secondary.env,
        GH_CONFIG_DIR: ghConfig,
      }),
      "org/demo\n",
    );
    assert.equal(seen.at(-1)?.headers.get("authorization"), `Bearer ${secret.githubSecondary}`);
  } finally {
    await relay[Symbol.asyncDispose]();
  }
});

function clientGrant(url: string, github = "github") {
  const broker = createCredentialBroker({
    url,
    auth: { apiKey },
    fetch: relayRequest,
  });

  return broker.sandbox({ github }).acquire(new AbortController().signal);
}

async function relayRequest(request: Request): Promise<Response> {
  const response = await runtime.dispatchFetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: request.body ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });

  return new Response(response.body, { status: response.status, headers: [...response.headers] });
}

async function relayHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url!, `https://${request.headers.host}`);
    const headers: [string, string][] = [];

    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push([request.rawHeaders[index], request.rawHeaders[index + 1]]);
    }

    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await buffer(request);

    const result = await runtime.dispatchFetch(url.href, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined);
  }
}

async function listen(server: Server, options: ListenOptions): Promise<void> {
  server.listen(options);
  await once(server, "listening");
}

function graphqlFixture(query: string) {
  const typeName = query.match(/(\w+):\s*__type/)?.[1];

  if (typeName)
    return RuntimeResponse.json({
      data: { [typeName]: { fields: [{ name: "number" }, { name: "id" }, { name: "url" }] } },
    });
  const issue = { id: "ISSUE_42", number: 42, url: "https://github.com/org/demo/issues/42" };
  const pull = { id: "PR_43", number: 43, url: "https://github.com/org/demo/pull/43" };
  const pageInfo = { hasNextPage: false, endCursor: null };

  const repository = {
    id: "REPO_DEMO",
    name: "demo",
    nameWithOwner: "org/demo",
    url: "https://github.com/org/demo",
    owner: { login: "org" },
    viewerPermission: "WRITE",
    hasIssuesEnabled: true,
    defaultBranchRef: { name: "main" },
    issues: { nodes: [issue], totalCount: 1, pageInfo },
    pullRequests: { nodes: [pull], totalCount: 1, pageInfo },
    issue,
    pullRequest: pull,
  };

  if (query.includes("mutation") && query.includes("createIssue")) {
    return RuntimeResponse.json({ data: { createIssue: { issue: { url: issue.url } } } });
  }

  if (query.includes("mutation") && query.includes("createPullRequest")) {
    return RuntimeResponse.json({ data: { createPullRequest: { pullRequest: pull } } });
  }

  if (query.includes("mutation") && query.includes("addComment")) {
    return RuntimeResponse.json({
      data: { addComment: { commentEdge: { node: { url: `${pull.url}#issuecomment-1` } } } },
    });
  }

  if (!query.includes("repository") && !query.includes("search")) {
    return RuntimeResponse.json({ data: { viewer: { login: "fixture" } } });
  }

  return RuntimeResponse.json({
    data: {
      repository,
      viewer: { login: "fixture" },
      search: {
        nodes: query.includes("PullRequest") ? [pull] : [issue],
        issueCount: 1,
        pageInfo,
      },
    },
  });
}

function startRuntime(state = "state") {
  return new Miniflare({
    ...convertV4MiniflareOptions(options),
    resourcePersistencePath: join(gitRoot, state),
  });
}

function sseFixture() {
  const encoder = new TextEncoder();

  return new RuntimeResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"first":true}\n\n'));
        sendStreamTail = () => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("streams data before completion and reclaims released or expired leases", async () => {
  const issued = await grant(["openai"]);
  const path = "/gateway/openai/v1/chat/completions";
  const body = JSON.stringify({ model: "fixture", stream: true });
  const requests = [];

  try {
    for (let index = 0; index < 3; index++) {
      const pending = await access(path, issued.token, "POST", body);
      assert.equal(pending.status, 200);
      assert.equal(pending.headers.get("content-type"), "text/event-stream");
      requests.push({ reader: pending.body!.getReader(), finish: sendStreamTail! });
    }

    const rejected = await access(path, issued.token, "POST", body);
    assert.equal(rejected.status, 429);

    const { reader, finish } = requests.shift()!;
    const head = await reader.read();
    assert.equal(new TextDecoder().decode(head.value), 'data: {"first":true}\n\n');
    finish();
    const tail = await reader.read();
    assert.equal(new TextDecoder().decode(tail.value), "data: [DONE]\n\n");
    assert.equal((await reader.read()).done, true);
    assert.equal(seen.at(-1)?.body, body);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] = await storage.exec(
        "SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?",
        issued.id,
      );

      if (row.count === 2) break;
      await delay(20);
    }

    assert.deepEqual(
      await storage.exec("SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?", issued.id),
      [{ count: 2 }],
    );

    const held = await access(path, issued.token, "POST", body);
    assert.equal(held.status, 200);
    requests.push({ reader: held.body!.getReader(), finish: sendStreamTail! });
    assert.equal((await access(path, issued.token, "POST", body)).status, 429);

    await storage.exec("UPDATE leases SET expires_at = 0 WHERE grant_id = ?", issued.id);

    const [renewed] = await storage.exec(
      "SELECT id FROM leases WHERE grant_id = ? LIMIT 1",
      issued.id,
    );

    const namespace = await runtime.getDurableObjectNamespace("REGISTRY");

    // SAFETY: REGISTRY is bound to GrantRegistry, whose RPC surface includes renewLease.
    const registry: { renewLease(id: string): Promise<void> } = namespace.getByName(
      "grant-registry",
    ) as never;

    await registry.renewLease(String(renewed.id));

    const afterExpiry = await access(path, issued.token, "POST", body);
    assert.equal(afterExpiry.status, 200);
    requests.push({ reader: afterExpiry.body!.getReader(), finish: sendStreamTail! });

    const remaining = await storage.exec("SELECT id FROM leases WHERE grant_id = ?", issued.id);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.some(({ id }) => id === renewed.id));
    assert.equal((await access(`/v1/grants/${issued.id}`, apiKey, "DELETE")).status, 204);
    assert.equal((await access(path, issued.token, "POST", body)).status, 401);
    assert.deepEqual(
      await storage.exec("SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?", issued.id),
      [{ count: 0 }],
    );
  } finally {
    for (const { reader, finish } of requests) {
      finish();

      while (!(await reader.read()).done) {
        // Drain fixture data before closing its loopback connection.
      }

      reader.releaseLock();
    }
  }
});

test(
  "retains grants and request limits across restart and applies the bundled migration once",
  { timeout: 15_000 },
  async () => {
    const original = runtime;
    runtime = startRuntime("restart-fixture");

    try {
      await seedIntegrations();
      const record = await grant(["openai", "openrouter"]);

      const previousStorage = await runtime.unsafeGetDurableObjectStorage(
        "broker",
        "GrantRegistry",
        {
          name: "grant-registry",
        },
      );

      const remainingInMinute = 60_000 - (Date.now() % 60_000);

      if (remainingInMinute < 2_000) await delay(remainingInMinute + 20);

      const window = Math.floor(Date.now() / 60_000);
      await previousStorage.exec(
        "INSERT INTO grant_usage SELECT ?, identity, ?, 599 FROM integrations WHERE id = 'openai'",
        record.id,
        window,
      );

      await runtime.dispose();
      runtime = startRuntime("restart-fixture");

      const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
        name: "grant-registry",
      });

      assert.deepEqual(await storage.exec("SELECT COUNT(*) AS count FROM __drizzle_migrations"), [
        { count: 6 },
      ]);

      const path = "/gateway/openai/v1/models";
      const response = await access(path, record.token);
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(
        await storage.exec("SELECT count FROM grant_usage WHERE grant_id = ?", record.id),
        [{ count: 600 }],
      );

      const forwarded = seen.length;
      assert.equal((await access(path, record.token)).status, 429);
      assert.equal(seen.length, forwarded);

      const otherIntegration = await access("/gateway/openrouter/v1/models", record.token);
      assert.equal(otherIntegration.status, 200);
      await otherIntegration.text();

      // Simulate a counter from the previous minute without waiting for wall-clock rollover.
      await storage.exec(
        "UPDATE grant_usage SET window = ? WHERE grant_id = ?",
        window - 1,
        record.id,
      );
      const allowed = await access(path, record.token);
      assert.equal(allowed.status, 200);
      await allowed.text();
      assert.deepEqual(
        await storage.exec(
          "SELECT count FROM grant_usage JOIN integrations USING (identity) WHERE grant_id = ? AND id = 'openai'",
          record.id,
        ),
        [{ count: 1 }],
      );
    } finally {
      await runtime.dispose();
      runtime = original;
    }
  },
);

test(
  "admission enforces per-owner and deployment-wide active grant bounds",
  { timeout: 15_000 },
  async () => {
    const original = runtime;
    runtime = startRuntime("capacity-fixture");

    try {
      await seedIntegrations();
      await grant(["openai"]);

      const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
        name: "grant-registry",
      });

      const expiresAt = Date.now() + 60_000;

      const seed = `
    WITH RECURSIVE sample(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sample WHERE n < ?)
    INSERT INTO grants (id, hash, owner, permissions, expires_at)
    SELECT ? || n, ? || n, `;

      await storage.exec(
        `${seed} 'broker-api-key', '[]', ? FROM sample`,
        98,
        "owner:",
        "owner:",
        expiresAt,
      );

      await grant(["openai"]);
      assert.equal((await issue(["openai"])).status, 429);

      await storage.exec(
        `${seed} 'fixture-owner:' || n, '[]', ? FROM sample`,
        899,
        "global:",
        "global:",
        expiresAt,
      );
      const authority = await githubToken();
      await grant(["github"], authority);
      assert.equal((await issue(["github"], await githubToken({ run_id: "301" }))).status, 429);
    } finally {
      await runtime.dispose();
      runtime = original;
    }
  },
);

test("separates administration, issuance, OIDC and sandbox access", async () => {
  const sample = JSON.stringify({
    id: "new-ai",
    kind: "openai",
    credential: { source: "encrypted-store", value: "admin-fixture-value" },
  });

  const oidc = await githubToken();
  const sandbox = (await grant(["openai"])).token;

  for (const denied of [apiKey, oidc, sandbox, rootKeyA]) {
    assert.equal((await admin("/integrations", "GET", undefined, denied)).status, 401);
    assert.equal((await admin("/integrations", "POST", "x".repeat(20_000), denied)).status, 401);
  }

  assert.equal((await issue(["openai"], adminKey)).status, 401);
  assert.equal((await issue(["openai"], rootKeyA)).status, 401);
  assert.equal((await access("/gateway/openai/v1/models", adminKey)).status, 401);
  assert.equal((await access("/gateway/openai/v1/models", apiKey)).status, 401);
  assert.equal((await access("/api/v3/user", sandbox)).status, 403);
  assert.equal((await admin("/integrations", "POST", "x".repeat(20_000))).status, 400);
  assert.equal(
    (
      await admin(
        "/integrations",
        "POST",
        JSON.stringify({
          id: "empty-secret",
          kind: "openai",
          credential: { source: "worker-secret", binding: "CREDENTIAL_MISSING" },
        }),
      )
    ).status,
    503,
  );
  assert.throws(
    () =>
      assertSeparateRoleKeys({ BROKER_ADMIN_KEY: apiKey, BROKER_ISSUER_KEY: apiKey }, [rootKeyA]),
    /must differ/,
  );
  assert.throws(
    () => assertSeparateRoleKeys({ BROKER_ADMIN_KEY: rootKeyA }, [rootKeyA]),
    /must differ/,
  );

  try {
    const created = await admin("/integrations", "POST", sample);
    assert.equal(created.status, 201);
    await created.text();
    assert.equal((await admin("/integrations", "POST", sample)).status, 409);
    assert.equal((await issue(["new-ai"])).status, 403);

    await eligible([...defaultNames, "new-ai"]);
    assert.equal((await issue(["new-ai"], oidc)).status, 403);
    assert.equal((await issue(["github", "github-secondary"])).status, 400);

    await eligible([]);
    assert.equal((await issue(["github"], oidc)).status, 403);
    assert.equal((await issue(["openai"])).status, 403);
    const existing = await access("/gateway/openai/v1/models", sandbox);
    assert.equal(existing.status, 200);
    await existing.text();
  } finally {
    await admin("/integrations/new-ai", "DELETE");
    await eligible(defaultNames);
  }
});

test("strips headers nominated by Connection wherever present at the runtime boundary", () => {
  const headers = endpointHeaders(
    new Headers({
      connection: "x-private, x-fixed",
      "x-private": "guest-transport-metadata",
      "x-fixed": "untrusted",
      "x-session-id": "kept",
    }),
    [{ name: "x-fixed", value: "configured" }],
    {},
    "fixture-grant",
  );

  assert.deepEqual(
    [...headers],
    [
      ["x-fixed", "configured"],
      ["x-session-id", "kept"],
    ],
  );
});

test("response filtering preserves content type for short secrets and strips reflected credentials", () => {
  const response = endpointResponseHeaders(
    new Headers({
      "content-type": "application/json",
      "x-plain-reflection": "a",
      "x-prefixed-reflection": "request used Bearer b",
      "x-long-reflection": "key=long-secret-fixture",
      "x-plain": "other-value",
    }),
    [
      { name: "x-plain", secret: true },
      { name: "authorization", secret: true, prefix: "Bearer " },
      { name: "x-long", secret: true },
    ],
    { "x-plain": "a", authorization: "b", "x-long": "long-secret-fixture" },
  );

  assert.deepEqual([...response], [["content-type", "application/json"]]);
});

test("proxies an administrator-configured endpoint and rotates one sealed header without disturbing its grant", async () => {
  const id = "custom-api";
  const gateway = `/gateway/${id}`;
  const url = "https://broker.test";
  const upstreamBase = "https://upstream.example.com/nested/v1";
  const first = "configured-upstream-key";
  const rotated = "rotated-upstream-key";
  const gatewayKey = "encrypted-gateway-key";
  const adminClient = createCredentialBrokerAdmin({ url, apiKey: adminKey, fetch: relayRequest });
  const broker = createCredentialBroker({ url, auth: { apiKey }, fetch: relayRequest });

  const endpoint = {
    baseURL: `${upstreamBase}/`,
    headers: [
      { name: "Authorization", secret: true, prefix: "Bearer " },
      { name: "CF-AIG-Authorization", secret: true, prefix: "Bearer " },
      { name: "X-Mode", value: "fixed-override" },
    ],
  } satisfies NonNullable<Awaited<ReturnType<typeof adminClient.integrations.get>>["endpoint"]>;

  const body = {
    kind: "http",
    id,
    endpoint,
    credential: {
      source: "encrypted-store",
      values: {
        authorization: first,
        "cf-aig-authorization": gatewayKey,
      },
    },
  } as const;

  try {
    const invalidEndpoints = [
      { ...endpoint, baseURL: "http://upstream.example.com" },
      { ...endpoint, baseURL: "https://owner:secret@upstream.example.com" },
      { ...endpoint, baseURL: `${upstreamBase}?token=secret` },
      { ...endpoint, baseURL: `${upstreamBase}/%2e%2e/elsewhere` },
      { ...endpoint, headers: [...endpoint.headers, { name: "Host", value: "evil.example.com" }] },
      {
        ...endpoint,
        headers: [...endpoint.headers, { name: "authorization", value: "duplicate" }],
      },
      { ...endpoint, headers: [...endpoint.headers, { name: "x-extra", value: "break\r\nfield" }] },
    ];

    for (const invalid of invalidEndpoints) {
      const response = await admin(
        "/integrations",
        "POST",
        JSON.stringify({ ...body, endpoint: invalid }),
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_integration" });
    }

    const created = await adminClient.integrations.create(body);
    assert.deepEqual(created.endpoint, {
      baseURL: upstreamBase,
      headers: endpoint.headers.map((header) => ({ ...header, name: header.name.toLowerCase() })),
    });
    assert.ok(!JSON.stringify(created).includes(first));
    assert.ok(!JSON.stringify(await adminClient.integrations.get(id)).includes(gatewayKey));
    assert.equal((await issue([id])).status, 403);
    await eligible([...defaultNames, id]);

    const sandbox = broker.sandbox({
      endpoints: [{ integration: id, baseURLEnv: "CUSTOM_URL", apiKeyEnv: "CUSTOM_KEY" }],
    });

    const result = await sandbox.acquire(new AbortController().signal);
    const token = result.env.CUSTOM_KEY;
    assert.equal(result.env.CUSTOM_URL, `${url}${gateway}`);

    const response = await runtime.dispatchFetch(
      `${result.env.CUSTOM_URL}/widgets/123?token=page-cursor&key=record`,
      {
        method: "DELETE",
        headers: {
          "x-api-key": token,
          "user-agent": "provider-tool/1.2.3",
          "x-session-id": "conversation-id",
          "x-mode": "guest-override",
          "cf-aig-authorization": "guest-cf-value",
          "cf-aig-byok-alias": "guest-alias",
          "cf-aig-collect-log": "true",
          "x-original-url": "/outside",
          "sentry-trace": "untrusted-context",
          "x-request-id": "application-request-identifier",
          "x-token-copy": `copied ${token}`,
          "x-forwarded-for": "192.0.2.1",
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
          cookie: "secret=guest-cookie",
        },
        body: "{}",
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { fixture: true });
    assert.equal(response.headers.get("x-page-count"), "2");

    const malformed = await runtime.dispatchFetch(`${result.env.CUSTOM_URL}/widgets/%E0%A4%A`, {
      headers: { "x-api-key": token },
    });

    assert.equal(malformed.status, 404);
    await malformed.text();

    for (const name of ["set-cookie", "cf-aig-authorization", "x-reflected-credential"])
      assert.equal(response.headers.get(name), null);

    const forwarded = seen.at(-1)!;
    assert.equal(forwarded.url.href, `${upstreamBase}/widgets/123?token=page-cursor&key=record`);
    assert.equal(forwarded.method, "DELETE");
    assert.equal(forwarded.body, "{}");
    assert.equal(forwarded.headers.get("authorization"), `Bearer ${first}`);
    assert.equal(forwarded.headers.get("cf-aig-authorization"), `Bearer ${gatewayKey}`);
    assert.equal(forwarded.headers.get("x-mode"), "fixed-override");
    assert.equal(forwarded.headers.get("x-session-id"), "conversation-id");
    assert.equal(forwarded.headers.get("user-agent"), "provider-tool/1.2.3");

    assert.equal(forwarded.headers.get("x-request-id"), "application-request-identifier");

    for (const name of [
      "x-api-key",
      "x-token-copy",
      "x-forwarded-for",
      "traceparent",
      "cookie",
      "cf-aig-byok-alias",
      "cf-aig-collect-log",
      "x-original-url",
      "sentry-trace",
    ])
      assert.equal(forwarded.headers.get(name), null);

    for (const suffix of ["", "/"]) {
      assert.equal((await access(`${gateway}${suffix}`, token)).status, 200);
      assert.equal(seen.at(-1)?.url.href, `${upstreamBase}${suffix}`);
    }

    assert.equal((await access(`${gateway}/info/refs?service=git-upload-pack`, token)).status, 200);
    assert.equal(seen.at(-1)?.url.pathname, "/nested/v1/info/refs");
    const initial = seen.length;

    for (const suffix of [
      "//outside",
      "/a%2Fb",
      "/a%5Cb",
      "/%252e%252e",
      "/..;/outside",
      "/..%3b/outside",
      "/..%20/outside",
      "/%2e%2e%3b/outside",
      `?cursor=${token}`,
    ]) {
      assert.equal((await access(`${gateway}${suffix}`, token)).status, 404);
    }

    assert.equal((await access("/gateway/openai/v1/models", token)).status, 403);
    assert.equal(seen.length, initial);
    assert.equal((await access(`${gateway}/redirect`, token)).status, 502);
    assert.deepEqual(
      seen.slice(initial).map(({ url: requestURL }) => requestURL.pathname),
      ["/nested/v1/redirect"],
    );

    const invalidRotation = await admin(
      `/integrations/${id}/credential`,
      "PUT",
      JSON.stringify({
        source: "encrypted-store",
        values: { "x-mode": "invalid-non-secret-slot" },
      }),
    );

    assert.equal(invalidRotation.status, 400);
    assert.equal(
      (
        await adminClient.integrations.rotate(id, {
          source: "encrypted-store",
          values: { AUTHORIZATION: rotated },
        })
      ).credentialVersion,
      2,
    );
    assert.equal((await access(`${gateway}/widgets/123`, token)).status, 200);
    assert.equal(seen.at(-1)?.headers.get("authorization"), `Bearer ${rotated}`);
    assert.equal(seen.at(-1)?.headers.get("cf-aig-authorization"), `Bearer ${gatewayKey}`);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    const rows = await storage.exec(
      "SELECT endpoint, credential FROM integrations WHERE id = ?",
      id,
    );

    assert.ok(![first, rotated, gatewayKey].some((value) => JSON.stringify(rows).includes(value)));

    const complete = {
      authorization: "whole-map-upstream-key",
      "cf-aig-authorization": "whole-map-gateway-key",
    };

    assert.equal(
      (await adminClient.integrations.rotate(id, { source: "encrypted-store", values: complete }))
        .credentialVersion,
      3,
    );

    const replacements: Record<string, string>[] = [
      { authorization: "parallel-upstream-key" },
      { "cf-aig-authorization": "parallel-gateway-key" },
    ];

    const writes = await Promise.allSettled(
      replacements.map((values) =>
        adminClient.integrations.rotate(id, { source: "encrypted-store", values }),
      ),
    );

    let successful = 0;

    for (const [index, write] of writes.entries()) {
      if (write.status === "fulfilled") {
        Object.assign(complete, replacements[index]);
        successful++;
      } else {
        assert.ok(write.reason instanceof CredentialBrokerError);
        assert.equal(write.reason.code, "CONFLICT");
      }
    }

    assert.ok(successful > 0);
    assert.equal((await adminClient.integrations.get(id)).credentialVersion, 3 + successful);
    const current = await access(`${gateway}/widgets/123`, token);
    assert.equal(current.status, 200);
    assert.equal(seen.at(-1)?.headers.get("authorization"), `Bearer ${complete.authorization}`);
    assert.equal(
      seen.at(-1)?.headers.get("cf-aig-authorization"),
      `Bearer ${complete["cf-aig-authorization"]}`,
    );

    const fixtureStream = await access(`${gateway}/stream`, token);
    assert.equal(fixtureStream.headers.get("content-type"), "text/event-stream");
    const reader = fixtureStream.body!.getReader();
    const initialChunk = await reader.read();
    assert.match(new TextDecoder().decode(initialChunk.value), /first/);
    sendStreamTail?.();
    assert.match(new TextDecoder().decode((await reader.read()).value), /DONE/);
    assert.equal((await reader.read()).done, true);

    const lookup = await storage.exec(
      "SELECT id FROM grants WHERE hash = ?",
      await tokenHash(token),
    );

    const grantId = lookup[0].id;

    for (let i = 0; i < 30; i++) {
      if (!(await storage.exec("SELECT id FROM leases WHERE grant_id = ?", grantId)).length) break;
      await delay(20);
    }

    assert.deepEqual(await storage.exec("SELECT id FROM leases WHERE grant_id = ?", grantId), []);

    await storage.exec(
      "UPDATE integrations SET endpoint = replace(endpoint, 'nested', 'tampered') WHERE id = ?",
      id,
    );
    const beforeTamper = seen.length;
    assert.equal((await access(gateway, token)).status, 503);
    assert.equal(seen.length, beforeTamper);
    await adminClient.integrations.setEnabled(id, false);
    assert.equal((await access(gateway, token)).status, 401);
  } finally {
    await adminClient.integrations.delete(id);
    await eligible(defaultNames);
  }
});

test("HTTP endpoint at an upstream origin root supports literal-only configuration", async () => {
  const id = "literal-api";
  const item = `/integrations/${id}`;
  const url = "https://upstream.example.com";
  const credential = { source: "encrypted-store", values: {} };

  try {
    const created = await admin(
      "/integrations",
      "POST",
      JSON.stringify({
        id,
        kind: "http",
        endpoint: { baseURL: `${url}/`, headers: [{ name: "x-mode", value: "literal" }] },
        credential,
      }),
    );

    assert.equal(created.status, 201);
    await eligible([...defaultNames, id]);
    const { token } = await grant([id]);
    const response = await access(`/gateway/${id}`, token, "PROPFIND");
    assert.equal(response.status, 200);
    assert.equal(seen.at(-1)?.url.href, `${url}/`);
    assert.equal(seen.at(-1)?.method, "PROPFIND");
    assert.equal(seen.at(-1)?.headers.get("authorization"), null);
    assert.equal(seen.at(-1)?.headers.get("x-mode"), "literal");
    const rotation = await admin(`${item}/credential`, "PUT", JSON.stringify(credential));
    assert.equal(rotation.status, 200);
    const rotated = z.object({ credentialVersion: z.number() }).parse(await rotation.json());
    assert.equal(rotated.credentialVersion, 2);
  } finally {
    await admin(item, "DELETE");
    await eligible(defaultNames);
  }
});

test("stores only sealed material, keeps rotation scope, and revokes on disable or deletion", async () => {
  const id = "managed-ai";
  const other = "managed-alternate";
  const item = `/integrations/${id}`;
  const path = `/gateway/${id}/v1/models`;
  const initial = "managed-credential-first-canary";
  const replacement = "managed-credential-rotated-canary";

  const url = "https://broker.test";
  const adminClient = createCredentialBrokerAdmin({ url, apiKey: adminKey, fetch: relayRequest });
  const issuerClient = createCredentialBroker({ url, auth: { apiKey }, fetch: relayRequest });

  const meta = z.strictObject({
    id: z.string(),
    kind: z.literal("openai"),
    enabled: z.boolean(),
    credentialSource: z.literal("encrypted-store"),
    credentialVersion: z.number(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  });

  const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
    name: "grant-registry",
  });

  const readSealed = async (name: string) => {
    const [row] = await storage.exec(
      "SELECT identity, credential FROM integrations WHERE id = ?",
      name,
    );

    return {
      identity: z.string().parse(row.identity),
      credential: z.string().parse(row.credential),
    };
  };

  const envelope = z.strictObject({
    source: z.literal("encrypted-store"),
    keyVersion: z.string(),
    nonce: z.string(),
    ciphertext: z.string(),
  });

  const rotate = (value: string) =>
    adminClient.integrations.rotate(id, { source: "encrypted-store", value });

  const enabled = async (value: boolean) => {
    const response = await admin(item, "PATCH", JSON.stringify({ enabled: value }));
    assert.equal(response.status, 200);
    assert.equal(meta.parse(await response.json()).enabled, value);
  };

  const proxy = async (token: string, value: string) => {
    const response = await access(path, token);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(seen.at(-1)?.headers.get("authorization"), `Bearer ${value}`);
  };

  try {
    const created = meta.parse(
      await createIntegration(id, "openai", { source: "encrypted-store", value: initial }),
    );

    const initialStored = await readSealed(id);
    assert.equal(created.credentialVersion, 1);
    assert.ok(!initialStored.credential.includes(initial));
    const sealed = envelope.parse(JSON.parse(initialStored.credential));
    assert.equal(sealed.keyVersion, "first");
    assert.equal(Buffer.from(sealed.nonce, "base64url").length, 12);

    const details = await admin(item);
    assert.equal(details.status, 200);
    assert.deepEqual(meta.extend({ issuable: z.boolean() }).parse(await details.json()), {
      ...created,
      issuable: false,
    });
    const catalog = await admin("/integrations");
    assert.equal(catalog.status, 200);
    const catalogJson = await catalog.text();

    for (const value of [
      initial,
      sealed.ciphertext,
      sealed.nonce,
      initialStored.identity,
      rootKeyA,
    ]) {
      assert.ok(!catalogJson.includes(value));
    }

    await createIntegration(other, "openai", {
      source: "encrypted-store",
      value: "unrelated-credential-canary",
    });
    const allowedNames = [...defaultNames, id, other];
    assert.deepEqual(await adminClient.issuerPermissions.set(allowedNames), {
      integrations: allowedNames.sort(),
    });
    const first = await issuerClient.issue({ integrations: [id, "openai"] });
    await proxy(first.token, initial);
    assert.equal((await access(`/gateway/${other}/v1/models`, first.token)).status, 403);

    assert.equal((await rotate(replacement)).credentialVersion, 2);
    await proxy(first.token, replacement);
    assert.equal((await rotate(replacement)).credentialVersion, 3);
    const rotatedStored = await readSealed(id);
    const rotated = envelope.parse(JSON.parse(rotatedStored.credential));
    assert.equal(rotatedStored.identity, initialStored.identity);
    assert.notEqual(rotated.nonce, sealed.nonce);
    assert.notEqual(rotated.ciphertext, sealed.ciphertext);
    assert.ok(!rotatedStored.credential.includes(replacement));

    const sibling = await readSealed(other);
    const beforeTamper = seen.length;
    await storage.exec(
      "UPDATE integrations SET credential = ? WHERE id = ?",
      sibling.credential,
      id,
    );
    assert.equal((await access(path, first.token)).status, 503);
    assert.equal(seen.length, beforeTamper);
    await storage.exec(
      "UPDATE integrations SET credential = ? WHERE id = ?",
      rotatedStored.credential,
      id,
    );
    await proxy(first.token, replacement);

    const concurrentValues = ["concurrent-rotation-a", "concurrent-rotation-b"];
    const writes = await Promise.allSettled(concurrentValues.map(rotate));
    const confirmed = [];

    for (const [index, write] of writes.entries()) {
      if (write.status === "fulfilled") {
        confirmed.push({ version: write.value.credentialVersion, value: concurrentValues[index] });
      } else {
        assert.ok(write.reason instanceof CredentialBrokerError);
        assert.equal(write.reason.code, "CONFLICT");
      }
    }

    const current = confirmed.sort((a, b) => b.version - a.version)[0];
    assert.ok(current);
    assert.equal(current.version, 3 + confirmed.length);
    assert.equal((await adminClient.integrations.get(id)).credentialVersion, current.version);
    await proxy(first.token, current.value);

    await enabled(false);
    assert.equal((await access(path, first.token)).status, 401);
    assert.equal((await access("/gateway/openai/v1/models", first.token)).status, 401);
    assert.equal((await issue([id])).status, 403);
    await enabled(true);
    assert.equal((await access(path, first.token)).status, 401);
    const second = await grant([id]);
    await proxy(second.token, current.value);

    assert.equal((await admin(item, "DELETE")).status, 204);
    assert.equal((await admin(item, "DELETE")).status, 204);
    assert.equal((await admin(item)).status, 404);
    assert.equal((await access(path, second.token)).status, 401);
    await createIntegration(id, "openai", { source: "encrypted-store", value: initial });
    assert.notEqual((await readSealed(id)).identity, initialStored.identity);
    assert.equal((await issue([id])).status, 403);
    await eligible([...defaultNames, id, other]);
    await proxy((await grant([id])).token, initial);
    assert.equal((await access(path, second.token)).status, 401);
  } finally {
    await admin(item, "DELETE");
    await admin(`/integrations/${other}`, "DELETE");
    await eligible(defaultNames);
  }
});

test("AES-GCM rejects tampering and binds identity, credential version and key version", async () => {
  const first = encryptionKeyring({
    BROKER_ENCRYPTION_KEYS: encryptionKeys,
    BROKER_ENCRYPTION_KEY_VERSION: "first",
  });

  const rotated = encryptionKeyring({
    BROKER_ENCRYPTION_KEYS: encryptionKeys,
    BROKER_ENCRYPTION_KEY_VERSION: "second",
  });

  const integration = {
    id: "managed-ai",
    kind: "openai",
    identity: crypto.randomUUID(),
    credentialVersion: 1,
  } as const;

  const value = "encryption-fixture-value";
  const record = await sealCredential(value, integration, first);
  const repeated = await sealCredential(value, integration, first);
  assert.notEqual(record.nonce, repeated.nonce);
  assert.notEqual(record.ciphertext, repeated.ciphertext);
  assert.deepEqual(await encryptedStoreSource(integration, rotated).resolve(record), { value });

  const newRecord = await sealCredential(value, integration, rotated);
  assert.equal(newRecord.keyVersion, "second");
  assert.deepEqual(await encryptedStoreSource(integration, rotated).resolve(newRecord), { value });

  const secondOnly = encryptionKeyring({
    BROKER_ENCRYPTION_KEYS: JSON.stringify({ second: rootKeyB }),
    BROKER_ENCRYPTION_KEY_VERSION: "second",
  });

  assert.equal(await encryptedStoreSource(integration, secondOnly).resolve(record), undefined);

  for (const revision of [
    { ...integration, identity: crypto.randomUUID() },
    { ...integration, credentialVersion: 2 },
  ]) {
    assert.equal(await encryptedStoreSource(revision, first).resolve(record), undefined);
  }

  const wrong = record.ciphertext.startsWith("A") ? "B" : "A";
  const ciphertext = wrong + record.ciphertext.slice(1);
  assert.equal(
    await encryptedStoreSource(integration, first).resolve({ ...record, ciphertext }),
    undefined,
  );

  const equalKeys = encryptionKeyring({
    BROKER_ENCRYPTION_KEYS: JSON.stringify({ first: rootKeyA, second: rootKeyA }),
    BROKER_ENCRYPTION_KEY_VERSION: "second",
  });

  assert.equal(
    await encryptedStoreSource(integration, equalKeys).resolve({ ...record, keyVersion: "second" }),
    undefined,
  );
  assert.throws(
    () =>
      encryptionKeyring({
        BROKER_ENCRYPTION_KEYS: JSON.stringify({ first: rootKeyA.slice(1) }),
        BROKER_ENCRYPTION_KEY_VERSION: "first",
      }),
    /Invalid broker encryption keyring configuration/,
  );
});

test("client and Worker agree on control-key format boundaries", () => {
  for (const key of ["a".repeat(32), "a".repeat(256)]) {
    assert.doesNotThrow(() => requireApiKey(key));
    assert.equal(isBrokerApiKey(key), true);
  }

  for (const key of ["a".repeat(31), "a".repeat(257), `bsg_${"a".repeat(64)}`]) {
    assert.throws(() => requireApiKey(key), { code: "INVALID_ARGUMENT" });
    assert.equal(isBrokerApiKey(key), false);
  }
});

test("client and Worker agree on serialized admin and grant limits", async () => {
  const original = runtime;
  runtime = startRuntime("contract-limits");

  const url = "https://broker.test";
  let calls = 0;

  async function countedFetch(request: Request): Promise<Response> {
    calls++;

    return relayRequest(request);
  }

  const adminClient = createCredentialBrokerAdmin({ url, apiKey: adminKey, fetch: countedFetch });
  const broker = createCredentialBroker({ url, auth: { apiKey }, fetch: countedFetch });
  const ids = Array.from({ length: 100 }, (_, index) => `boundary-${index}`);
  const encrypted = (value: string): CredentialInput => ({ source: "encrypted-store", value });

  try {
    for (const invalid of ["", "x".repeat(4097)]) {
      const before = calls;
      const payload = { id: ids[0], kind: "openai" as const, credential: encrypted(invalid) };
      await assert.rejects(adminClient.integrations.create(payload), { code: "INVALID_ARGUMENT" });
      assert.equal(calls, before);
      assert.equal((await admin("/integrations", "POST", JSON.stringify(payload))).status, 400);
    }

    for (const binding of ["CREDENTIAL_A", `CREDENTIAL_${"A".repeat(80)}`]) {
      const before = calls;

      const payload = {
        id: ids[0],
        kind: "openai" as const,
        credential: { source: "worker-secret" as const, binding },
      };

      await assert.rejects(adminClient.integrations.create(payload), { code: "UNAVAILABLE" });
      assert.equal(calls, before + 1);

      const result = await admin("/integrations", "POST", JSON.stringify(payload));
      assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), { error: "credential_unavailable" });
    }

    for (const binding of ["CREDENTIAL_", `CREDENTIAL_${"A".repeat(81)}`]) {
      const before = calls;

      const payload = {
        id: ids[0],
        kind: "openai" as const,
        credential: { source: "worker-secret" as const, binding },
      };

      await assert.rejects(adminClient.integrations.create(payload), { code: "INVALID_ARGUMENT" });
      assert.equal(calls, before);
      assert.equal((await admin("/integrations", "POST", JSON.stringify(payload))).status, 400);
    }

    for (const [index, id] of ids.entries()) {
      // A quote needs JSON escaping, so this also covers the maximum serialized secret body.
      const credential: CredentialInput =
        index === 0
          ? encrypted("x")
          : index === 1
            ? encrypted('"'.repeat(4096))
            : { source: "worker-secret", binding: "CREDENTIAL_OPENAI" };

      assert.equal(
        (await adminClient.integrations.create({ id, kind: "openai", credential }))
          .credentialVersion,
        1,
      );
    }

    assert.equal((await adminClient.integrations.list()).length, 100);
    await assert.rejects(
      adminClient.integrations.create({
        id: "too-many",
        kind: "openai",
        credential: encrypted("x"),
      }),
      { code: "RATE_LIMIT" },
    );

    assert.deepEqual(await adminClient.issuerPermissions.set(ids), {
      integrations: [...ids].sort(),
    });
    const oversizedPermissions = [...ids, "too-many"];
    const beforePermissions = calls;
    await assert.rejects(adminClient.issuerPermissions.set(oversizedPermissions), {
      code: "INVALID_ARGUMENT",
    });
    assert.equal(calls, beforePermissions);
    assert.equal(
      (
        await admin(
          "/issuer-permissions",
          "PUT",
          JSON.stringify({ integrations: oversizedPermissions }),
        )
      ).status,
      400,
    );

    const integrations = ids.slice(0, 16);

    for (const ttlSeconds of [1, 3600, 604_800]) {
      const granted = await broker.issue({ integrations, ttlSeconds });
      assert.deepEqual(granted.integrations, integrations);
      await broker.revoke(granted.id);
    }

    for (const request of [
      { integrations, ttlSeconds: 0 },
      { integrations, ttlSeconds: 604_801 },
      { integrations: ids.slice(0, 17), ttlSeconds: 60 },
    ]) {
      const before = calls;
      await assert.rejects(broker.issue(request), { code: "INVALID_ARGUMENT" });
      assert.equal(calls, before);
      assert.equal((await issue(request.integrations, apiKey, request.ttlSeconds)).status, 400);
    }
  } finally {
    await runtime.dispose();
    runtime = original;
  }
});

test("explains refused issuance, lists and renews grants, and reports status by role", async () => {
  const url = "https://broker.test";
  const broker = createCredentialBroker({ url, auth: { apiKey }, fetch: relayRequest });
  const adminClient = createCredentialBrokerAdmin({ url, apiKey: adminKey, fetch: relayRequest });

  const refusal = async (integrations: string[]) => {
    const response = await issue(integrations);
    assert.equal(response.status, 403);

    return response.json();
  };

  assert.deepEqual(await refusal(["missing-one"]), {
    error: "integration_forbidden",
    reason: "not_found",
    integrations: ["missing-one"],
  });

  await createIntegration("parked", "openai", { source: "encrypted-store", value: "parked-key" });
  assert.deepEqual(await refusal(["openai", "parked"]), {
    error: "integration_forbidden",
    reason: "not_allowlisted",
    integrations: ["parked"],
  });

  await assert.rejects(broker.issue({ integrations: ["parked"] }), {
    code: "FORBIDDEN",
    reason: "not_allowlisted",
    message: /beachside-broker issuer allow parked/,
  });

  assert.ok((await adminClient.issuerPermissions.allow("parked")).integrations.includes("parked"));
  assert.ok((await adminClient.issuerPermissions.allow("parked")).integrations.includes("parked"));
  assert.equal((await adminClient.integrations.get("parked")).issuable, true);
  await adminClient.integrations.setEnabled("parked", false);
  assert.deepEqual(await refusal(["parked"]), {
    error: "integration_forbidden",
    reason: "disabled",
    integrations: ["parked"],
  });
  await adminClient.integrations.setEnabled("parked", true);
  assert.ok(!(await adminClient.issuerPermissions.deny("parked")).integrations.includes("parked"));
  await assert.rejects(adminClient.issuerPermissions.allow("missing-one"), {
    code: "NOT_FOUND",
    message: /Integration missing-one was not found/,
  });

  const week = 604_800;

  const granted = await broker.issue({
    integrations: ["openai"],
    ttlSeconds: week,
    label: "box web",
  });

  assert.deepEqual(granted.kinds, { openai: "openai" });
  assert.ok(Date.parse(granted.expiresAt) - Date.now() > (week - 60) * 1_000);

  const response = await access("/gateway/openai/v1/models", granted.token);
  assert.equal(response.status, 200);
  await response.text();

  const mine = await broker.list();
  const listed = mine.find(({ id }) => id === granted.id);
  assert.equal(listed?.label, "box web");
  assert.deepEqual(listed?.integrations, ["openai"]);
  assert.equal(listed?.requests, 1);
  assert.ok(listed?.lastUsedAt);
  assert.equal(listed?.owner, undefined);

  const everyone = await adminClient.grants.list();
  assert.equal(everyone.find(({ id }) => id === granted.id)?.owner, "broker-api-key");

  const renewed = await broker.renew(granted.id, 60);
  assert.ok(Date.parse(renewed.expiresAt) - Date.now() <= 60_000);
  await assert.rejects(broker.renew(granted.id, week + 1), { code: "INVALID_ARGUMENT" });
  assert.equal(
    (
      await runtime.dispatchFetch(`${url}/v1/grants/${granted.id}/renew`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ttlSeconds: week + 1 }),
      })
    ).status,
    400,
  );

  await broker.revoke(granted.id);
  await assert.rejects(broker.renew(granted.id, 60), { code: "NOT_FOUND" });

  const sandbox = await broker
    .sandbox({ endpoints: [{ integration: "openai", baseURLEnv: "BASE", apiKeyEnv: "KEY" }] })
    .acquire(AbortSignal.timeout(5_000));

  assert.equal(sandbox.env.BASE, `${url}/gateway/openai/v1`);
  assert.ok(Date.parse(await sandbox.renew(120, AbortSignal.timeout(5_000))) > Date.now());
  await sandbox.revoke(AbortSignal.timeout(5_000));

  assert.equal((await broker.status()).role, "issuer");
  const status = await adminClient.status();
  assert.equal(status.role, "admin");
  assert.equal(status.limits.maxGrantTtlSeconds, week);
  assert.ok((status.counts?.integrations ?? 0) >= defaultNames.length);
  assert.equal((await runtime.dispatchFetch(`${url}/v1/status`)).status, 401);

  const config = await adminClient.config();
  assert.equal(config.issuerKey, true);
  assert.equal(config.githubActions?.audience, audience);
  assert.equal(config.workerSecretBindings, kinds.length + 1);
  assert.deepEqual(config.limits.openai, {
    requestsPerMinute: 600,
    concurrentRequests: 3,
    configured: true,
  });
  assert.deepEqual(config.limits.github, {
    requestsPerMinute: 800,
    concurrentRequests: 32,
    configured: false,
  });
  assert.deepEqual(config.unknownLimitIds, ["retired"]);

  await adminClient.integrations.delete("parked");
});

test("scopes GitHub Actions grant listing and renewal to the issuing run, and counts what is issuable", async () => {
  const url = "https://broker.test";
  const authority = await githubToken();
  const otherRun = await githubToken({ run_id: "302" });

  const outside = await issue(["openai"], authority);
  assert.equal(outside.status, 403);
  assert.deepEqual(await outside.json(), {
    error: "integration_forbidden",
    reason: "not_in_policy",
    integrations: ["openai"],
  });

  const status = await access("/v1/status", authority);
  assert.equal(status.status, 200);
  assert.equal(z.object({ role: z.string() }).parse(await status.json()).role, "github-actions");

  const record = await grant(["github"], authority);

  const listed = async (token: string) => {
    const response = await access("/v1/grants", token);
    assert.equal(response.status, 200);

    const { grants } = z
      .object({ grants: z.array(z.object({ id: z.string() })) })
      .parse(await response.json());

    return grants.map(({ id }) => id);
  };

  assert.ok((await listed(authority)).includes(record.id));
  assert.ok(!(await listed(otherRun)).includes(record.id));
  assert.ok(!(await listed(apiKey)).includes(record.id));

  const renew = (token: string) =>
    runtime.dispatchFetch(`${url}/v1/grants/${record.id}/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 120 }),
    });

  const foreign = await renew(otherRun);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "grant_not_found" });
  const foreignIssuer = await renew(apiKey);
  assert.equal(foreignIssuer.status, 404);
  await foreignIssuer.text();
  const own = await renew(authority);
  assert.equal(own.status, 200);
  await own.text();

  const adminClient = createCredentialBrokerAdmin({ url, apiKey: adminKey, fetch: relayRequest });
  const before = (await adminClient.status()).counts!;
  const extra = await grant(["openai"]);
  assert.equal((await adminClient.status()).counts!.activeGrants, before.activeGrants + 1);

  await adminClient.integrations.setEnabled("anthropic", false);
  const disabled = (await adminClient.status()).counts!;
  assert.equal(disabled.issuable, before.issuable - 1);
  assert.equal(disabled.integrations, before.integrations);
  await adminClient.integrations.setEnabled("anthropic", true);
  assert.equal((await adminClient.status()).counts!.issuable, before.issuable);

  await adminClient.issuerPermissions.deny("anthropic");
  assert.equal((await adminClient.status()).counts!.issuable, before.issuable - 1);
  await adminClient.issuerPermissions.allow("anthropic");

  assert.equal((await access(`/v1/grants/${record.id}`, authority, "DELETE")).status, 204);
  assert.equal((await access(`/v1/grants/${extra.id}`, apiKey, "DELETE")).status, 204);
});

test("canaries answer like unknown grants, stay hidden from issuers and alert each destination at most hourly", async () => {
  const slack = await admin(
    "/alerts",
    "POST",
    JSON.stringify({
      id: "ops-chat",
      kind: "slack",
      url: "https://hooks.slack.com/services/T0/B0/slack-secret",
    }),
  );

  assert.equal(slack.status, 201);
  await slack.text();

  const webhook = await admin(
    "/alerts",
    "POST",
    JSON.stringify({
      id: "pager",
      kind: "webhook",
      url: "https://alerts.example.com/hook?routing=url-secret",
      headers: { Authorization: "Bearer header-secret" },
    }),
  );

  assert.equal(webhook.status, 201);

  const { signingSecret } = z
    .object({ signingSecret: z.string().startsWith("whsec_") })
    .parse(await webhook.json());

  const oversized = await admin(
    "/alerts",
    "POST",
    JSON.stringify({
      id: "oversized",
      kind: "webhook",
      url: "https://alerts.example.com/hook",
      headers: Object.fromEntries(
        ["a", "b", "c", "d"].map((name) => [`x-${name}`, "v".repeat(4096)]),
      ),
    }),
  );

  assert.equal(oversized.status, 400);
  await oversized.text();

  for (const url of [
    "https://example.com/slack",
    "http://hooks.slack.com/x",
    "https://1.2.3.4/x",
  ]) {
    const refused = await admin(
      "/alerts",
      "POST",
      JSON.stringify({ id: "bad", kind: "slack", url }),
    );

    assert.equal(refused.status, 400);
    await refused.text();
  }

  const destinations = await (await admin("/alerts")).text();

  for (const value of ["slack-secret", "url-secret", "header-secret", signingSecret])
    assert.ok(!destinations.includes(value));

  const issued = await admin(
    "/canaries",
    "POST",
    JSON.stringify({ integrations: ["openai"], label: "decoy env" }),
  );

  assert.equal(issued.status, 201);

  const canary = grantSchema
    .extend({ kinds: z.record(z.string(), z.string()) })
    .parse(await issued.json());

  assert.deepEqual(canary.kinds, { openai: "openai" });
  assert.ok(!(await (await access("/v1/grants", apiKey)).text()).includes(canary.id));
  assert.ok(!(await (await admin("/grants")).text()).includes(canary.id));

  const sent = seen.length;
  const unknown = await access("/gateway/openai/v1/models", `bsg_${"0".repeat(64)}`);
  const tripped = await access("/gateway/openai/v1/models", canary.token);
  assert.equal(tripped.status, unknown.status);
  assert.deepEqual([...tripped.headers], [...unknown.headers]);
  assert.equal(await tripped.text(), await unknown.text());

  const alerts = () =>
    seen
      .slice(sent)
      .filter(({ url }) => ["hooks.slack.com", "alerts.example.com"].includes(url.hostname));

  for (let attempt = 0; attempt < 100 && alerts().length < 2; attempt++) await delay(20);
  const [first, second] = alerts();
  assert.ok(first && second);

  for (const { body } of alerts()) assert.ok(!body.includes(canary.token));

  const hook = first.url.hostname === "alerts.example.com" ? first : second;
  const chat = hook === first ? second : first;
  assert.match(z.object({ text: z.string() }).parse(JSON.parse(chat.body)).text, /decoy env/);
  assert.equal(hook.headers.get("authorization"), "Bearer header-secret");

  const id = hook.headers.get("webhook-id");
  const timestamp = hook.headers.get("webhook-timestamp");

  const signature = createHmac("sha256", Buffer.from(signingSecret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${hook.body}`)
    .digest("base64");

  assert.equal(hook.headers.get("webhook-signature"), `v1,${signature}`);

  const event = z.record(z.string(), z.string()).parse(JSON.parse(hook.body));
  assert.equal(event.type, "canary.triggered");
  assert.equal(event.dedup_key, `beachside-canary-${canary.id}`);
  assert.equal(event.request_route, "gateway");
  assert.equal(event.request_integration, "openai");
  assert.equal(event.trips_since_last_alert, "1");

  const asIssuer = await issue(["openai"], canary.token);
  assert.equal(asIssuer.status, 401);
  await asIssuer.text();
  await delay(200);
  assert.equal(alerts().length, 2);

  const shown = z
    .object({ trips: z.number(), events: z.array(z.object({ route: z.string() })) })
    .parse(await (await admin(`/canaries/${canary.id}`)).json());

  assert.equal(shown.trips, 2);
  assert.deepEqual(
    shown.events.map(({ route }) => route),
    ["issuer-auth", "gateway"],
  );

  const tested = await (await admin("/alerts/pager/test", "POST")).text();
  assert.equal(
    z.object({ delivered: z.boolean() }).parse(JSON.parse(tested)).delivered,
    true,
    tested,
  );

  const email = await admin(
    "/alerts",
    "POST",
    JSON.stringify({ id: "inbox", kind: "email", to: "oncall@example.com" }),
  );

  assert.equal(email.status, 201);
  assert.equal(z.object({ host: z.string() }).parse(await email.json()).host, "oncall@example.com");

  const mailed = await (await admin("/alerts/inbox/test", "POST")).json();
  assert.deepEqual(mailed, { id: "inbox", status: 202, delivered: true });
  assert.equal((await admin("/alerts/inbox", "DELETE")).status, 204);

  assert.equal((await admin(`/canaries/${canary.id}`, "DELETE")).status, 204);
  assert.equal((await admin("/alerts/ops-chat", "DELETE")).status, 204);
  assert.equal((await admin("/alerts/pager", "DELETE")).status, 204);
});
