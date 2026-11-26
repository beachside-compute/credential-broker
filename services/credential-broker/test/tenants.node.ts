import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import { z } from "zod";
import type { V4WorkerOptions } from "miniflare";
import type { PlatformControl, PlatformOperator } from "../src/tenants/platform-rpc";
import { brokerHosts, isBrokerHost, requestTenant } from "../src/tenants/hosts";
import { parseConfig } from "../src/config";
import type { TrustedIssuer } from "../src/config";
import { createCredentialBrokerAdmin } from "../../../src/admin";

const admin = "default-admin-fixture-0123456789abcdef";

const issuer = "default-issuer-fixture-0123456789abcdef";

const platform = "platform-fixture-0123456789abcdef";

const platformOperator = "platform-operator-fixture-0123456789abcdef";

const domain = "broker.example.org";

const tenantA = "a".repeat(32);

const tenantB = "tenantbb";

const unknown = "unknown1";

const a = `${tenantA}.${domain}`;

const b = `${tenantB}.${domain}`;

const host = `${unknown}.${domain}`;

const platformPath = "/v1/platform/tenants";

const integrationPath = "/v1/admin/integrations";

const gatewayPath = "/gateway/model/v1/responses";

const oidcIssuer = "https://token.actions.githubusercontent.com";

const grantToken = z.object({ id: z.string(), token: z.string().regex(/^bsg_[a-f0-9]{64}$/) });

const keys = z.object({ id: z.string(), adminKey: z.string(), issuerKey: z.string() });

const rotatedKey = z.object({ key: z.string() });

const policy = {
  repositoryId: "100",
  repositoryOwnerId: "200",
  repository: "beachside-compute/fixture",
  ref: "refs/heads/main",
  workflowRef: "beachside-compute/fixture/.github/workflows/test.yml@refs/heads/main",
  event: "push",
  integrations: ["model"],
} as const;

const github = await generateKeyPair("RS256");

const githubJwk = { ...(await exportJWK(github.publicKey)), kid: "fixture" };

const trustedIssuer = "https://authority.example.net";

const trustedAudience = `https://${domain}`;

const trustedJWKS = `${trustedIssuer}/.well-known/jwks.json`;

const trusted = await generateKeyPair("ES256");

const trustedJwk = { ...(await exportJWK(trusted.publicKey)), kid: "trusted-fixture" };

const policyEntry = {
  issuer: trustedIssuer,
  jwksUri: trustedJWKS,
  audience: trustedAudience,
  roles: ["admin", "issuer"],
} satisfies TrustedIssuer;

const rootKeys = JSON.stringify({
  v1: Buffer.alloc(32, 42).toString("base64url"),
  v2: Buffer.alloc(32, 58).toString("base64url"),
});

const worker = await build({
  entryPoints: [`${import.meta.dirname}/../../src/index.ts`],
  write: false,
  bundle: true,
  format: "esm",
  external: ["cloudflare:*"],
  loader: { ".sql": "text" },
});

function options(
  enabled = true,
  root = "v1",
  registry = true,
  policyEntry?: TrustedIssuer,
  rpc = false,
  routing = enabled,
) {
  const alerts: string[] = [];

  const broker: V4WorkerOptions = {
    name: "broker",
    modules: true,
    script: worker.outputFiles[0].text,
    compatibilityDate: "2026-09-25",
    unsafeInspectDurableObjects: true,
    durableObjects: {
      ...(registry && { REGISTRY: { className: "GrantRegistry", useSQLite: true } }),
      ...(enabled && { DIRECTORY: { className: "TenantDirectory", useSQLite: true } }),
    },
    bindings: {
      BROKER_ADMIN_KEY: admin,
      BROKER_ISSUER_KEY: issuer,
      BROKER_ENCRYPTION_KEYS: rootKeys,
      BROKER_ENCRYPTION_KEY_VERSION: root,
      ...(routing && { BROKER_TENANT_DOMAIN: domain }),
      BROKER_HOST_ALIASES: "default-broker.example.net",
      BROKER_CONFIG: JSON.stringify({
        githubActions: { audience: "default-audience", workflows: [policy] },
        ...(policyEntry && { trustedIssuers: [policyEntry] }),
      }),
      ...(enabled && {
        BROKER_PLATFORM_KEY: platform,
        BROKER_PLATFORM_OPERATOR_KEY: platformOperator,
        ...(!rpc && { BROKER_PLATFORM_HTTP_ENABLED: "true" }),
      }),
    },
    async outboundService(request) {
      const url = new URL(request.url);

      if (url.href === `${oidcIssuer}/.well-known/jwks`)
        return RuntimeResponse.json({ keys: [githubJwk] });

      if (url.href === trustedJWKS) return RuntimeResponse.json({ keys: [trustedJwk] });

      if (url.hostname === "api.openai.com" || url.hostname === "github.com")
        return RuntimeResponse.json({ auth: request.headers.get("authorization") });

      if (url.hostname === "alerts.example.net") {
        alerts.push(url.pathname);

        return RuntimeResponse.json({ received: true });
      }

      throw new Error("Unexpected fixture destination");
    },
  };

  const client: V4WorkerOptions = {
    name: "platform-client",
    modules: true,
    script: "export default {fetch: () => new Response(null, {status: 404})};",
    compatibilityDate: "2026-09-25",
    serviceBindings: {
      CONTROL: { name: "broker", entrypoint: "PlatformControl" },
      OPERATOR: { name: "broker", entrypoint: "PlatformOperator" },
    },
  };

  return {
    alerts,
    worker: convertV4MiniflareOptions(
      rpc ? { unsafeInspectDurableObjects: true, workers: [broker, client] } : broker,
    ),
  };
}

function fixture(
  enabled = true,
  registry = true,
  entry?: TrustedIssuer,
  rpc = false,
  routing = enabled,
) {
  const { worker, alerts } = options(enabled, "v1", registry, entry, rpc, routing);
  const runtime = new Miniflare(worker);

  async function call<Payload>(
    hostname: string,
    path: string,
    key: string,
    method = "GET",
    payload?: Payload,
  ) {
    const auth = key.startsWith("Basic ") ? key : `Bearer ${key}`;

    return runtime.dispatchFetch(`https://${hostname}${path}`, {
      method,
      headers: {
        authorization: auth,
        ...(payload && { "content-type": "application/json" }),
      },
      ...(payload && { body: JSON.stringify(payload) }),
    });
  }

  const operate = <Payload>(path = "", method = "GET", payload?: Payload) =>
    call(
      domain,
      platformPath + path,
      method === "PATCH" || method === "DELETE" || (method === "POST" && path)
        ? platformOperator
        : platform,
      method,
      payload,
    );

  async function provision(id: string) {
    const reply = await operate("", "POST", { id });
    assert.equal(reply.status, 201);
    assert.equal(reply.headers.get("cache-control"), "no-store");

    return keys.parse(await reply.json());
  }

  async function seed(hostname: string, key: string, id: string, value: string, kind = "openai") {
    const reply = await call(hostname, integrationPath, key, "POST", {
      id,
      kind,
      credential: { source: "encrypted-store", value },
    });

    assert.equal(reply.status, 201);
    assert.equal(
      (await call(hostname, `/v1/admin/issuer-permissions/${id}`, key, "PUT")).status,
      200,
    );
  }

  const issue = (hostname: string, key: string, integration = "model") =>
    call(hostname, "/v1/grants", key, "POST", { integrations: [integration], ttlSeconds: 600 });

  const storage = (id: string) =>
    runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", { name: `tenant/${id}` });

  return { runtime, alerts, call, operate, provision, seed, issue, storage };
}

type Fixture = ReturnType<typeof fixture>;

async function error(response: Awaited<ReturnType<Fixture["call"]>>, status: number, code: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
}

async function jwt(audience: string) {
  return new SignJWT({
    repository_id: policy.repositoryId,
    repository_owner_id: policy.repositoryOwnerId,
    repository: policy.repository,
    ref: policy.ref,
    workflow_ref: policy.workflowRef,
    event_name: policy.event,
    run_id: "300",
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(oidcIssuer)
    .setAudience(audience)
    .setSubject("fixture")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(github.privateKey);
}

test("host selection isolates authorization, data keys, credentials and limits", async () => {
  const broker = fixture();
  const { runtime, call, provision, seed, issue, storage } = broker;

  try {
    const [left, right] = await Promise.all([provision(tenantA), provision(tenantB)]);
    await Promise.all([
      seed(a, left.adminKey, "model", "upstream-a"),
      seed(b, right.adminKey, "model", "upstream-b"),
    ]);
    await Promise.all([
      error(
        await call(b, integrationPath, left.adminKey),
        401,
        "administrator_authentication_required",
      ),
      error(
        await call(domain, integrationPath, left.adminKey),
        401,
        "administrator_authentication_required",
      ),
      error(await call(a, integrationPath, admin), 401, "administrator_authentication_required"),
      error(await issue(b, left.issuerKey), 401, "orchestrator_authentication_required"),
      error(await issue(domain, left.issuerKey), 401, "orchestrator_authentication_required"),
      error(await issue(a, issuer), 401, "orchestrator_authentication_required"),
      error(await issue(a, left.adminKey), 401, "orchestrator_authentication_required"),
      error(
        await call(a, integrationPath, left.issuerKey),
        401,
        "administrator_authentication_required",
      ),
    ]);

    const [ga, gb] = await Promise.all([
      issue(a, left.issuerKey).then(async (r) => grantToken.parse(await r.json())),
      issue(b, right.issuerKey).then(async (r) => grantToken.parse(await r.json())),
    ]);

    await error(await call(b, gatewayPath, ga.token, "POST"), 401, "grant_invalid");
    await error(await call(domain, gatewayPath, ga.token, "POST"), 401, "grant_invalid");
    assert.deepEqual(await (await call(a, gatewayPath, ga.token, "POST")).json(), {
      auth: "Bearer upstream-a",
    });
    assert.deepEqual(await (await call(b, gatewayPath, gb.token, "POST")).json(), {
      auth: "Bearer upstream-b",
    });

    const client = createCredentialBrokerAdmin({
      url: `https://${a}`,
      apiKey: left.adminKey,
      fetch: async (request) => {
        const response = await runtime.dispatchFetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body ? await request.text() : undefined,
        });

        return new Response(response.status === 204 ? null : await response.text(), {
          status: response.status,
        });
      },
    });

    const config = {
      limits: { model: { requestsPerMinute: 1 } },
      githubActions: { audience: `beachside-broker:${tenantA}`, workflows: [policy] },
    };

    await client.setConfig(config);
    assert.equal((await client.config()).limits.model.requestsPerMinute, 1);
    await error(
      await call(domain, "/v1/admin/config", admin, "PUT", {}),
      409,
      "config_managed_by_deployment",
    );
    await error(
      await call(b, "/v1/admin/config", right.adminKey, "PUT", config),
      400,
      "invalid_config",
    );
    assert.equal(
      (
        await call(b, "/v1/admin/config", right.adminKey, "PUT", {
          githubActions: { audience: `beachside-broker:${tenantB}`, workflows: [policy] },
        })
      ).status,
      204,
    );
    assert.equal((await issue(a, await jwt(config.githubActions.audience))).status, 201);
    await error(
      await issue(b, await jwt(config.githubActions.audience)),
      401,
      "orchestrator_authentication_required",
    );
    await error(
      await issue(b, await jwt("default-audience")),
      401,
      "orchestrator_authentication_required",
    );

    const issued = await Promise.all(Array.from({ length: 98 }, () => issue(a, left.issuerKey)));
    assert.ok(issued.every((reply) => reply.status === 201));

    const fresh = grantToken.parse(await (await issue(a, left.issuerKey)).json());
    assert.equal((await call(a, gatewayPath, fresh.token, "POST")).status, 200);
    await error(await call(a, gatewayPath, fresh.token, "POST"), 429, "grant_request_limit");
    assert.equal((await call(b, gatewayPath, gb.token, "POST")).status, 200);

    await error(await issue(a, left.issuerKey), 429, "grant_limit");
    assert.equal((await issue(b, right.issuerKey)).status, 201);
    assert.equal((await call(a, `/v1/grants/${ga.id}`, left.issuerKey, "DELETE")).status, 204);

    await seed(a, left.adminKey, "git", "git-fixture-secret", "github");
    const git = grantToken.parse(await (await issue(a, left.issuerKey, "git")).json());
    const basic = `Basic ${Buffer.from(`x-access-token:${git.token}`).toString("base64")}`;
    assert.equal(
      (await call(a, "/org/repo.git/info/refs?service=git-upload-pack", basic)).status,
      200,
    );

    const [storeA, storeB] = await Promise.all([storage(tenantA), storage(tenantB)]);

    const [sealed] = await storeA.exec(
      "SELECT identity, credential FROM integrations WHERE id = 'model'",
    );

    await storeB.exec("DELETE FROM issuer_integrations");
    await storeB.exec(
      "UPDATE integrations SET identity = ?, credential = ? WHERE id = 'model'",
      sealed.identity,
      sealed.credential,
    );
    await storeB.exec(
      "UPDATE grants SET permissions = ? WHERE id = ?",
      JSON.stringify([sealed.identity]),
      gb.id,
    );
    await error(await call(b, gatewayPath, gb.token, "POST"), 503, "credential_unavailable");

    const [wrapped] = await storeA.exec("SELECT wrapped FROM data_keys");
    const [other] = await storeB.exec("SELECT wrapped FROM data_keys");
    assert.notEqual(wrapped.wrapped, other.wrapped);
    await storeB.exec("UPDATE data_keys SET wrapped = ?", wrapped.wrapped);
    await runtime.setOptions(options(true, "v2").worker);
    // A runtime restart clears the isolate's data-key cache.
    await error(await call(b, "/v1/status", right.adminKey), 503, "broker_unavailable");

    assert.equal((await broker.operate(`/${tenantA}/rewrap`, "POST")).status, 204);
    const [rewrapped] = await (await storage(tenantA)).exec("SELECT wrapped FROM data_keys");
    assert.equal(
      z.object({ keyVersion: z.literal("v2") }).safeParse(JSON.parse(String(rewrapped.wrapped)))
        .success,
      true,
    );
  } finally {
    await runtime.dispose();
  }
});

test("platform lifecycle hides missing tenants, rotates roles, and confines alerts", async () => {
  const { runtime, call, operate, provision, seed, issue, storage, alerts } = fixture();

  try {
    const [left, right] = await Promise.all([provision(tenantA), provision(tenantB)]);
    await seed(a, left.adminKey, "model", "upstream-a");
    const grant = grantToken.parse(await (await issue(a, left.issuerKey)).json());
    const listing = await (await operate("?limit=1")).json();

    const page = z.object({
      tenants: z.tuple([z.object({ id: z.literal(tenantA) })]),
      next: z.literal(tenantA),
    });

    assert.ok(page.safeParse(listing).success);

    const key = "a".repeat(64);
    const notGranted = `bsg_${key}`;
    await error(
      await call(host, integrationPath, left.adminKey),
      401,
      "administrator_authentication_required",
    );
    await error(
      await call(`bad-id.${domain}`, integrationPath, left.adminKey),
      401,
      "administrator_authentication_required",
    );
    await error(
      await call(a, integrationPath, right.adminKey),
      401,
      "administrator_authentication_required",
    );

    for (const [hostname, credentials, path] of [
      [a, left, "/a"],
      [b, right, "/b"],
    ] as const) {
      assert.equal(
        (
          await call(hostname, "/v1/admin/alerts", credentials.adminKey, "POST", {
            id: "alert",
            kind: "webhook",
            url: `https://alerts.example.net${path}`,
          })
        ).status,
        201,
      );
    }

    await error(
      await call(a, "/v1/admin/alerts", left.adminKey, "POST", {
        id: "self",
        kind: "webhook",
        url: `https://${b}/`,
      }),
      400,
      "invalid_alert_destination",
    );
    await error(
      await call(a, "/v1/admin/alerts", left.adminKey, "POST", {
        id: "mail",
        kind: "email",
        to: "operator@example.org",
      }),
      400,
      "email_alerts_not_configured",
    );
    await error(
      await call(a, integrationPath, left.adminKey, "POST", {
        id: "internal",
        kind: "http",
        endpoint: { baseURL: "https://default-broker.example.net", headers: [] },
        credential: { source: "encrypted-store", values: {} },
      }),
      400,
      "invalid_integration",
    );
    const secretInput = { source: "worker-secret", binding: "CREDENTIAL_FIXTURE" };
    await error(
      await call(a, integrationPath, left.adminKey, "POST", {
        id: "internal",
        kind: "openai",
        credential: secretInput,
      }),
      400,
      "invalid_integration",
    );
    await error(
      await call(a, `${integrationPath}/model/credential`, left.adminKey, "PUT", secretInput),
      400,
      "invalid_integration",
    );

    const store = await storage(tenantA);

    for (const [path, method, code] of [
      [gatewayPath, "POST", "grant_invalid"],
      [integrationPath, "GET", "administrator_authentication_required"],
      [platformPath, "GET", "platform_authentication_required"],
    ]) {
      const canary = grantToken.parse(
        await (
          await call(a, "/v1/admin/canaries", left.adminKey, "POST", { integrations: ["model"] })
        ).json(),
      );

      await store.exec("UPDATE alert_destinations SET last_alert_at = NULL");
      await error(await call(b, path, canary.token, method), 401, code);
      const expected = alerts.length + 1;
      await error(await call(a, path, canary.token, method), 401, code);

      for (let attempt = 0; alerts.length < expected && attempt < 40; attempt++) await delay(20);

      assert.equal(alerts.length, expected);
    }

    assert.deepEqual(alerts, ["/a", "/a", "/a"]);

    await store.exec(
      "UPDATE integrations SET credential = ? WHERE id = 'model'",
      JSON.stringify(secretInput),
    );
    await error(await call(a, gatewayPath, grant.token, "POST"), 503, "credential_unavailable");

    const rotation = await operate(`/${tenantA}/keys/admin/rotate`, "POST");
    const rotated = rotatedKey.parse(await rotation.json()).key;
    await error(
      await call(a, integrationPath, left.adminKey),
      401,
      "administrator_authentication_required",
    );
    assert.equal((await call(a, integrationPath, rotated)).status, 200);
    assert.equal((await operate(`/${tenantA}`, "PATCH", { status: "suspended" })).status, 200);

    for (const hostname of [a, host, b]) {
      await error(await call(hostname, gatewayPath, notGranted, "POST"), 401, "grant_invalid");
      await error(
        await call(hostname, "/v1/grants", issuer),
        401,
        "orchestrator_authentication_required",
      );
      await error(await call(hostname, "/v1/status", issuer), 401, "authentication_required");
      await error(
        await call(hostname, platformPath, issuer),
        401,
        "platform_authentication_required",
      );
    }

    assert.equal((await operate(`/${tenantA}`, "PATCH", { status: "active" })).status, 200);
    assert.equal((await call(a, integrationPath, rotated)).status, 200);
    assert.equal((await operate(`/${tenantA}`, "DELETE")).status, 204);
    assert.equal((await operate(`/${tenantA}`, "DELETE")).status, 204);
    assert.deepEqual(await store.exec("SELECT id FROM tenant"), []);
    assert.deepEqual(await store.exec("SELECT id FROM integrations"), []);
    await error(await operate("", "POST", { id: tenantA }), 409, "tenant_exists");
  } finally {
    await runtime.dispose();
  }
});

test("unconfigured tenancy rejects hosted requests without the directory binding", async () => {
  const { runtime, call, operate } = fixture(false);

  try {
    await error(await operate(), 404, "unsupported_route");
    await error(await call(a, gatewayPath, `bsg_${"a".repeat(64)}`, "POST"), 401, "grant_invalid");
    assert.equal((await call(domain, "/v1/status", admin)).status, 200);
  } finally {
    await runtime.dispose();
  }
});

test("unknown subdomains never need a registry binding", async () => {
  const { runtime, call } = fixture(true, false);

  try {
    await error(
      await call(host, integrationPath, admin),
      401,
      "administrator_authentication_required",
    );
    await error(
      await call(host, gatewayPath, `bsg_${"a".repeat(64)}`, "POST"),
      401,
      "grant_invalid",
    );
  } finally {
    await runtime.dispose();
  }
});

test("host aliases normalize operator input and fail closed for invalid settings", () => {
  const bindings = {
    BROKER_TENANT_DOMAIN: domain,
    BROKER_HOST_ALIASES: " LOCAL.EXAMPLE.NET. , worker.account.workers.dev, ",
  };

  assert.deepEqual(brokerHosts(bindings).aliases, [
    "local.example.net",
    "worker.account.workers.dev",
  ]);
  assert.deepEqual(brokerHosts({ BROKER_HOST_ALIASES: "" }).aliases, []);
  assert.throws(() =>
    brokerHosts({
      BROKER_HOST_ALIASES: Array.from({ length: 33 }, (_, id) => `host${id}.example.net`).join(","),
    }),
  );
  assert.throws(() => brokerHosts({ BROKER_TENANT_DOMAIN: domain, BROKER_HOST_ALIASES: a }));
  assert.equal(requestTenant(bindings, "https://worker.account.workers.dev"), "default");
  assert.equal(requestTenant(bindings, "https://unlisted.account.workers.dev"), undefined);
  assert.equal(
    isBrokerHost(bindings, `https://${a}`, new URL("https://worker.account.workers.dev")),
    true,
  );
  assert.equal(isBrokerHost(bindings, `https://${a}`, new URL("https://api.example.net")), false);
});

interface SignedTokenOptions {
  role?: "admin" | "issuer";
  subject?: string;
  tenant?: string;
  audience?: string | string[];
  issuer?: string;
  expiration?: string;
  issuedAt?: number;
  integrations?: string[];
  algorithm?: "ES256" | "RS256";
}

async function signed({
  role = "issuer",
  subject = "agent-1",
  tenant = tenantA,
  audience = trustedAudience,
  issuer = trustedIssuer,
  expiration = "5m",
  issuedAt = Math.floor(Date.now() / 1_000),
  integrations,
  algorithm = "ES256",
}: SignedTokenOptions = {}) {
  return new SignJWT({ role, tenant, integrations })
    .setProtectedHeader({ alg: algorithm, kid: "trusted-fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiration)
    .sign(algorithm === "ES256" ? trusted.privateKey : github.privateKey);
}

test("trusted issuers act on one hosted subdomain and own only their subject's grants", async () => {
  const { runtime, call, operate, provision, seed, issue } = fixture(true, true, policyEntry);

  try {
    const tenant = await provision(tenantA);
    await provision(tenantB);
    await seed(a, tenant.adminKey, "model", "trusted-model-fixture");
    const adminToken = await signed({ role: "admin" });
    const issuerToken = await signed();
    const agentTwo = await signed({ subject: "agent-2" });
    const status = z.object({ role: z.enum(["admin", "issuer"]) });

    assert.equal(
      status.parse(await (await call(a, "/v1/status", adminToken)).json()).role,
      "admin",
    );
    assert.equal(
      status.parse(await (await call(a, "/v1/status", issuerToken)).json()).role,
      "issuer",
    );
    await error(
      await call(a, integrationPath, issuerToken),
      401,
      "administrator_authentication_required",
    );
    await error(await issue(a, adminToken), 401, "orchestrator_authentication_required");

    const config = z.object({
      trustedIssuers: z.array(z.strictObject({ issuer: z.string(), roles: z.array(z.string()) })),
    });

    assert.deepEqual(
      config.parse(await (await call(a, "/v1/admin/config", adminToken)).json()).trustedIssuers,
      [{ issuer: trustedIssuer, roles: ["admin", "issuer"] }],
    );

    await seed(a, tenant.adminKey, "other", "trusted-other-fixture");
    const record = grantToken.parse(await (await issue(a, issuerToken)).json());
    const second = grantToken.parse(await (await issue(a, issuerToken, "other")).json());
    const narrowedToken = await signed({ integrations: ["model"] });
    const visible = z.object({ grants: z.array(z.object({ id: z.string() })) });
    assert.deepEqual(
      visible.parse(await (await call(a, "/v1/grants", narrowedToken)).json()).grants,
      [{ id: record.id }],
    );
    const broader = `/v1/grants/${second.id}`;
    await error(
      await call(a, broader + "/renew", narrowedToken, "POST", { ttlSeconds: 60 }),
      404,
      "grant_not_found",
    );
    assert.equal((await call(a, broader, narrowedToken, "DELETE")).status, 204);
    assert.equal(
      (await call(a, broader + "/renew", issuerToken, "POST", { ttlSeconds: 60 })).status,
      200,
    );
    const grantPath = `/v1/grants/${record.id}`;
    await error(
      await call(a, grantPath + "/renew", agentTwo, "POST", { ttlSeconds: 60 }),
      404,
      "grant_not_found",
    );
    assert.equal((await call(a, grantPath, agentTwo, "DELETE")).status, 204);
    assert.equal((await call(a, gatewayPath, record.token, "POST")).status, 200);
    assert.equal(
      (await call(a, grantPath + "/renew", issuerToken, "POST", { ttlSeconds: 60 })).status,
      200,
    );
    assert.equal((await call(a, grantPath, issuerToken, "DELETE")).status, 204);
    await error(await call(a, gatewayPath, record.token, "POST"), 401, "grant_invalid");

    const narrowed = await issue(a, await signed({ integrations: [] }));
    assert.equal(narrowed.status, 403);
    assert.deepEqual(await narrowed.json(), {
      error: "integration_forbidden",
      reason: "not_in_policy",
      integrations: ["model"],
    });

    for (const bad of [
      { audience: "https://another-broker.example.org" },
      { audience: [trustedAudience] },
      { issuer: "https://untrusted.example.org" },
      { expiration: "-1s" },
      { issuedAt: Math.floor(Date.now() / 1_000) - 601 },
      { algorithm: "RS256" },
      { subject: "a".repeat(129) },
      { tenant: tenantB },
    ] satisfies SignedTokenOptions[]) {
      await error(await issue(a, await signed(bad)), 401, "orchestrator_authentication_required");
    }

    await error(await issue(b, issuerToken), 401, "orchestrator_authentication_required");
    await error(await issue(domain, issuerToken), 401, "orchestrator_authentication_required");
    await error(
      await issue(host, await signed({ tenant: unknown })),
      401,
      "orchestrator_authentication_required",
    );
    assert.equal((await operate(`/${tenantA}`, "PATCH", { status: "suspended" })).status, 200);
    await error(await issue(a, issuerToken), 401, "orchestrator_authentication_required");
  } finally {
    await runtime.dispose();
  }
});

test("a pinned issuer works on the default hostname without a directory", async () => {
  const entry: TrustedIssuer = { ...policyEntry, roles: ["issuer"], tenant: tenantA };
  const { runtime, call, seed, issue, operate } = fixture(false, true, entry);

  try {
    assert.throws(() => parseConfig(JSON.stringify({ trustedIssuers: [policyEntry] })));
    assert.ok(
      parseConfig(JSON.stringify({ trustedIssuers: [policyEntry] }), true).trustedIssuers?.length,
    );

    await seed(domain, admin, "model", "pinned-model-fixture");
    assert.equal((await issue(domain, await signed())).status, 201);
    await error(
      await issue(domain, await signed({ tenant: tenantB })),
      401,
      "orchestrator_authentication_required",
    );
    await error(
      await call(domain, integrationPath, await signed({ role: "admin" })),
      401,
      "administrator_authentication_required",
    );
    await error(await issue(a, await signed()), 401, "orchestrator_authentication_required");
    await error(await operate(), 404, "unsupported_route");
  } finally {
    await runtime.dispose();
  }
});

test("private platform bindings work with public platform HTTP off", async () => {
  const { runtime, call } = fixture(true, true, undefined, true);

  try {
    const { CONTROL, OPERATOR } = await runtime.getBindings<{
      CONTROL: Pick<PlatformControl, "provision" | "inspect" | "list">;
      OPERATOR: Pick<PlatformOperator, "erase" | "rotateRoleKey" | "setStatus" | "auditLog">;
    }>("platform-client");

    await error(await call(domain, platformPath, platform), 404, "unsupported_route");
    await error(await call(domain, platformPath, platformOperator), 404, "unsupported_route");

    const created = await CONTROL.provision({ id: tenantA });
    assert.equal((await CONTROL.inspect({ id: tenantA })).status, "active");
    assert.deepEqual(
      (await CONTROL.list()).tenants.map(({ id }) => id),
      [tenantA],
    );
    assert.equal((await call(a, "/v1/status", created.adminKey)).status, 200);
    await assert.rejects(async () => CONTROL.provision({ id: "default" }), /invalid_tenant/);

    // SAFETY: Deliberately test a forbidden RPC method against the routine binding.
    const wrongBinding = CONTROL as typeof CONTROL & Pick<typeof OPERATOR, "erase">;
    await assert.rejects(async () => wrongBinding.erase({ id: tenantA }));
    await OPERATOR.setStatus({ id: tenantA, status: "suspended" });
    assert.equal((await CONTROL.inspect({ id: tenantA })).status, "suspended");
    await OPERATOR.rotateRoleKey({ id: tenantA, role: "admin" });
    await OPERATOR.erase({ id: tenantA });

    const audit = await OPERATOR.auditLog();
    const page = await OPERATOR.auditLog({ limit: 1, tenant: tenantA });
    assert.equal(page.records[0].operation, "erase");
    assert.equal(
      (await OPERATOR.auditLog({ before: page.next!, limit: 1 })).records[0].operation,
      "rotate_admin",
    );
    assert.deepEqual(
      audit.records.map(({ actor, operation, outcome }) => ({ actor, operation, outcome })),
      [
        { actor: "operator-binding", operation: "erase", outcome: "ok" },
        { actor: "operator-binding", operation: "rotate_admin", outcome: "ok" },
        { actor: "operator-binding", operation: "suspend", outcome: "ok" },
        { actor: "control-binding", operation: "provision", outcome: "ok" },
      ],
    );
  } finally {
    await runtime.dispose();
  }
});

test("opt-in platform HTTP separates the routine and operator bearer credentials", async () => {
  const { runtime, call, provision } = fixture();

  try {
    await provision(tenantA);
    await error(
      await call(domain, `${platformPath}/${tenantA}`, platform, "DELETE"),
      403,
      "platform_operator_required",
    );
    await error(
      await call(domain, platformPath, platformOperator),
      403,
      "platform_control_required",
    );
    assert.equal(
      (await call(domain, `${platformPath}/${tenantA}`, platformOperator, "DELETE")).status,
      204,
    );
  } finally {
    await runtime.dispose();
  }
});

test("platform provisioning requires a hostname suffix through HTTP and RPC", async () => {
  const http = fixture(true, true, undefined, false, false);
  const rpc = fixture(true, true, undefined, true, false);

  try {
    await error(await http.operate("", "POST", { id: tenantA }), 503, "tenant_domain_unconfigured");

    const { CONTROL } = await rpc.runtime.getBindings<{
      CONTROL: Pick<PlatformControl, "provision" | "list">;
    }>("platform-client");

    await assert.rejects(
      async () => CONTROL.provision({ id: tenantA }),
      /tenant_domain_unconfigured/,
    );
    assert.deepEqual((await CONTROL.list()).tenants, []);
  } finally {
    await Promise.all([http.runtime.dispose(), rpc.runtime.dispose()]);
  }
});

test("an operator audit row remains visible after an outcome write fails", async () => {
  const { runtime } = fixture(true, true, undefined, true);

  try {
    const { CONTROL, OPERATOR } = await runtime.getBindings<{
      CONTROL: Pick<PlatformControl, "provision">;
      OPERATOR: Pick<PlatformOperator, "rotateRoleKey" | "auditLog">;
    }>("platform-client");

    await CONTROL.provision({ id: tenantA });

    const directory = await runtime.unsafeGetDurableObjectStorage("broker", "TenantDirectory", {
      name: "tenant-directory",
    });

    await directory.exec(
      "CREATE TRIGGER fixture_audit_failure BEFORE UPDATE OF outcome ON platform_audit BEGIN SELECT RAISE(FAIL, 'fixture fault'); END",
    );
    const result = await OPERATOR.rotateRoleKey({ id: tenantA, role: "issuer" });
    assert.equal(result.role, "issuer");
    await directory.exec(
      "UPDATE platform_audit SET started_at = 0 WHERE operation = 'rotate_issuer'",
    );

    const [{ outcome, completion }] = (await OPERATOR.auditLog({ limit: 1 })).records;
    assert.equal(outcome, null);
    assert.equal(completion, "unconfirmed");
  } finally {
    await runtime.dispose();
  }
});

test("tenant data key rotation resumes and retires the old key only after resealing", async () => {
  const { runtime, call, operate, provision, seed, issue, storage } = fixture();

  try {
    const tenant = await provision(tenantA);
    const other = await provision(tenantB);
    await seed(a, tenant.adminKey, "model", "rotation-a");
    await seed(b, other.adminKey, "model", "rotation-b");
    const grant = grantToken.parse(await (await issue(a, tenant.issuerKey)).json());

    assert.equal(
      (
        await call(a, "/v1/admin/alerts", tenant.adminKey, "POST", {
          id: "alerts",
          kind: "webhook",
          url: "https://alerts.example.net/rotation",
        })
      ).status,
      201,
    );

    const store = await storage(tenantA);
    const [destination] = await store.exec("SELECT config FROM alert_destinations");
    const [credential] = await store.exec("SELECT credential FROM integrations WHERE id = 'model'");
    const rotate = `/${tenantA}/data-key/rotate`;

    assert.equal((await call(a, gatewayPath, grant.token, "POST")).status, 200);
    await error(
      await call(domain, platformPath + rotate, platform, "POST"),
      403,
      "platform_operator_required",
    );

    await store.exec(
      "UPDATE alert_destinations SET config = json_set(config, '$.ciphertext', 'corrupt')",
    );
    await error(await operate(rotate, "POST"), 409, "tenant_ciphertext_unavailable");
    assert.deepEqual(await store.exec("SELECT active_data_key AS version FROM tenant"), [
      { version: "t2" },
    ]);
    assert.deepEqual(await store.exec("SELECT version FROM data_keys ORDER BY version"), [
      { version: "t1" },
      { version: "t2" },
    ]);

    await seed(a, tenant.adminKey, "added", "rotation-new-write");
    assert.deepEqual(
      await store.exec(
        "SELECT json_extract(credential, '$.keyVersion') AS version FROM integrations WHERE id = 'added'",
      ),
      [{ version: "t2" }],
    );
    await store.exec("UPDATE alert_destinations SET config = ?", destination.config);

    const retry = await operate(rotate, "POST");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { id: tenantA, keyVersion: "t2" });
    assert.deepEqual(await store.exec("SELECT version FROM data_keys"), [{ version: "t2" }]);
    const [updated] = await store.exec("SELECT credential FROM integrations WHERE id = 'model'");
    assert.notEqual(updated.credential, credential.credential);

    const delivery = await call(a, "/v1/admin/alerts/alerts/test", tenant.adminKey, "POST");
    assert.equal(delivery.status, 200);
    assert.equal(z.object({ delivered: z.boolean() }).parse(await delivery.json()).delivered, true);
    assert.deepEqual(await (await call(a, gatewayPath, grant.token, "POST")).json(), {
      auth: "Bearer rotation-a",
    });
    assert.deepEqual(await (await storage(tenantB)).exec("SELECT version FROM data_keys"), [
      { version: "t1" },
    ]);
  } finally {
    await runtime.dispose();
  }
});
