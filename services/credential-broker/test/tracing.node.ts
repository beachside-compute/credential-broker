import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import { z } from "zod";
import type { TraceExportBindings } from "../src/observability/otlp";
import { startSpan } from "../src/observability/tracing";

const endpoint = "https://collector.test/v1/traces";

const collectorAuthorization = "Bearer collector-secret-canary";

const apiKey = "orchestrator-secret-canary-123456789";

const adminKey = "administrator-secret-canary-123456789";

const upstreamKey = "upstream-secret-canary";

const gatewayBody = '{"input":"prompt-canary"}';

const traceId = "1".repeat(32);

const parentSpanId = "2".repeat(16);

const traceparent = `00-${traceId}-${parentSpanId}-01`;

const sdkScope = "beachside.credential-broker";

const result = await build({
  entryPoints: [`${import.meta.dirname}/../../src/index.ts`],
  bundle: true,
  write: false,
  format: "esm",
  external: ["cloudflare:*"],
  loader: { ".sql": "text" },
});

const spanSchema = z.object({
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  spanId: z.string().regex(/^[a-f0-9]{16}$/),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.literal(2),
  startTimeUnixNano: z.coerce.bigint(),
  endTimeUnixNano: z.coerce.bigint(),
  attributes: z.tuple([
    z.object({
      key: z.literal("http.response.status_code"),
      value: z.object({ intValue: z.coerce.number() }),
    }),
  ]),
  links: z.array(z.object({ traceId: z.string(), spanId: z.string() })),
  events: z.tuple([]),
  status: z.strictObject({ code: z.number() }),
});

const otlp = z.object({
  resourceSpans: z.tuple([
    z.object({
      resource: z.object({
        attributes: z.tuple([
          z.object({
            key: z.literal("service.name"),
            value: z.object({ stringValue: z.literal(sdkScope) }),
          }),
        ]),
      }),
      scopeSpans: z.tuple([
        z.object({
          scope: z.object({ name: z.literal(sdkScope) }),
          spans: z.tuple([spanSchema]),
        }),
      ]),
    }),
  ]),
});

function fixture(bindings: TraceExportBindings, collectorStatus = 200) {
  const exported: { authorization: string | null; contentType: string | null; body: string }[] = [];
  let upstreamCalls = 0;

  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "broker",
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-09-25",
      durableObjects: { REGISTRY: { className: "GrantRegistry", useSQLite: true } },
      bindings: {
        BROKER_ADMIN_KEY: adminKey,
        BROKER_ISSUER_KEY: apiKey,
        BROKER_ENCRYPTION_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 42).toString("base64url") }),
        BROKER_ENCRYPTION_KEY_VERSION: "v1",
        ...bindings,
      },
      async outboundService(request) {
        if (request.url === endpoint) {
          assert.equal(request.method, "POST");
          exported.push({
            authorization: request.headers.get("authorization"),
            contentType: request.headers.get("content-type"),
            body: await request.text(),
          });

          return new RuntimeResponse("collector-response-canary", { status: collectorStatus });
        }

        assert.equal(request.url, "https://api.openai.com/v1/responses?query=query-canary");
        assert.equal(request.headers.get("authorization"), `Bearer ${upstreamKey}`);
        assert.equal(request.headers.get("traceparent"), null);
        assert.equal(await request.text(), gatewayBody);
        upstreamCalls++;

        return RuntimeResponse.json({ fixture: "response-canary" });
      },
    }),
  );

  const provision = async () => {
    const headers = {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      traceparent: traceparent.replace(/01$/, "00"),
    };

    const created = await runtime.dispatchFetch("http://broker.test/v1/admin/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "trace-canary",
        kind: "openai",
        credential: { source: "encrypted-store", value: upstreamKey },
      }),
    });

    assert.equal(created.status, 201);
    await created.text();

    const permitted = await runtime.dispatchFetch(
      "http://broker.test/v1/admin/issuer-permissions",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ integrations: ["trace-canary"] }),
      },
    );

    assert.equal(permitted.status, 200);
    await permitted.text();
  };

  let provisioning: Promise<void> | undefined;

  return {
    exported,
    runtime,
    upstreamCalls: () => upstreamCalls,
    async issue(parent = traceparent) {
      await (provisioning ??= provision());

      const response = await runtime.dispatchFetch("http://broker.test/v1/grants", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          traceparent: parent,
        },
        body: JSON.stringify({ integrations: ["trace-canary"], ttlSeconds: 60 }),
      });

      assert.equal(response.status, 201);

      return z.object({ id: z.string(), token: z.string() }).parse(await response.json());
    },
    async gateway(token: string) {
      const response = await runtime.dispatchFetch(
        "http://broker.test/gateway/trace-canary/v1/responses?query=query-canary",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            traceparent: `00-${"f".repeat(32)}-${"f".repeat(16)}-01`,
            baggage: "trace-canary=baggage-canary",
          },
          body: gatewayBody,
        },
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { fixture: "response-canary" });
    },
    async spans(count: number) {
      for (let attempt = 0; exported.length < count && attempt < 100; attempt++) await delay(10);
      assert.equal(exported.length, count);

      return exported.map(
        ({ body }) => otlp.parse(JSON.parse(body)).resourceSpans[0].scopeSpans[0].spans[0],
      );
    },
  };
}

test("exports safe sampled grant and gateway spans with the verified parent and persisted link", async () => {
  const broker = fixture({
    BROKER_OTLP_TRACES_ENDPOINT: endpoint,
    BROKER_OTLP_AUTHORIZATION: collectorAuthorization,
  });

  try {
    const grant = await broker.issue();
    await broker.gateway(grant.token);
    await broker.issue(traceparent.replace(/01$/, "00"));
    const spans = await broker.spans(2);
    const issuance = spans.find(({ name }) => name === "beachside.broker.grant.create")!;
    const gateway = spans.find(({ name }) => name === "beachside.broker.gateway")!;
    assert.partialDeepStrictEqual(issuance, { traceId, parentSpanId, links: [] });
    assert.equal(issuance.attributes[0].value.intValue, 201);
    assert.equal(gateway.parentSpanId, undefined);
    assert.notEqual(gateway.traceId, traceId);
    assert.notEqual(gateway.traceId, "f".repeat(32));
    assert.deepEqual(gateway.links, [{ traceId, spanId: issuance.spanId }]);
    assert.equal(gateway.attributes[0].value.intValue, 200);

    for (const span of spans) assert.ok(span.endTimeUnixNano >= span.startTimeUnixNano);

    for (const request of broker.exported) {
      assert.equal(request.authorization, collectorAuthorization);
      assert.equal(request.contentType, "application/json");

      for (const canary of [
        apiKey,
        adminKey,
        upstreamKey,
        collectorAuthorization,
        grant.token,
        grant.id,
        "trace-canary",
        "query-canary",
        "prompt-canary",
        "baggage-canary",
        "response-canary",
        "/v1/responses",
      ]) {
        assert.ok(!request.body.includes(canary));
      }
    }
  } finally {
    await broker.runtime.dispose();
  }
});

test("collector rejection leaves grant issuance and upstream forwarding successful", async () => {
  const broker = fixture({ BROKER_OTLP_TRACES_ENDPOINT: endpoint }, 503);

  try {
    const grant = await broker.issue();
    await broker.gateway(grant.token);
    await broker.spans(2);
    assert.equal(broker.upstreamCalls(), 1);
    assert.equal(
      broker.exported.every(({ authorization }) => authorization === null),
      true,
    );
  } finally {
    await broker.runtime.dispose();
  }
});

test("disabled tracing makes no collector requests", async () => {
  const broker = fixture({});

  try {
    const grant = await broker.issue();
    await broker.gateway(grant.token);
    assert.equal(broker.upstreamCalls(), 1);
  } finally {
    await broker.runtime.dispose();
  }

  assert.deepEqual(broker.exported, []);
});

for (const [index, bindings] of [
  { BROKER_OTLP_TRACES_ENDPOINT: "http://collector.test/v1/traces" },
  { BROKER_OTLP_TRACES_ENDPOINT: endpoint, BROKER_OTLP_AUTHORIZATION: "invalid\r\nauthorization" },
].entries()) {
  test(`invalid runtime tracing settings skip instrumentation ${index}`, () => {
    const span = startSpan(
      bindings,
      () => {
        throw new Error("Unexpected export");
      },
      "grant.create",
    );

    assert.equal(span, undefined);
  });
}

test("exports a static administrator span without integration IDs or request credentials", async () => {
  const broker = fixture({ BROKER_OTLP_TRACES_ENDPOINT: endpoint });
  const id = "admin-integration-canary";
  const value = "admin-credential-canary";

  const body = JSON.stringify({
    id,
    kind: "openai",
    credential: { source: "encrypted-store", value },
  });

  try {
    const response = await broker.runtime.dispatchFetch(
      "http://broker.test/v1/admin/integrations",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminKey}`,
          "content-type": "application/json",
          traceparent,
        },
        body,
      },
    );

    assert.equal(response.status, 201);
    await response.text();

    const [span] = await broker.spans(1);
    assert.equal(span.name, "beachside.broker.admin.integration.create");
    assert.equal(span.traceId, traceId);
    assert.equal(span.parentSpanId, parentSpanId);
    assert.equal(span.attributes[0].value.intValue, 201);

    for (const canary of [adminKey, id, value, "/v1/admin/integrations"]) {
      assert.ok(!broker.exported[0].body.includes(canary));
    }
  } finally {
    await broker.runtime.dispose();
  }
});
