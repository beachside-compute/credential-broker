import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialBroker, githubActionsOidc } from "./index";

const key = "fixture_credential_broker_control_key";

const token = `bsg_${"a".repeat(64)}`;

const id = "685daa5a-0771-4ef8-9e41-3a5a913e7a04";

const url = "https://broker.example.invalid";

const expiresAt = "2030-01-01T00:00:00.000Z";

const traceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function grantResponse(integrations: string[]) {
  return Response.json({ id, token, expiresAt, integrations }, { status: 201 });
}

test("configures a GitHub and model grant and authenticates control calls only", async () => {
  const calls: Request[] = [];

  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch(request) {
      calls.push(request);

      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const grant = await request.json();

      expect(grant).toEqual({
        integrations: ["github", "claude", "gpt", "router"],
        ttlSeconds: 300,
      });

      return grantResponse(grant.integrations);
    },
  });

  const credentials = broker.sandbox({
    github: "github",
    anthropic: "claude",
    openai: "gpt",
    openrouter: "router",
    ttlSeconds: 300,
  });

  const grant = await credentials.acquire(new AbortController().signal, traceParent);

  expect(grant.env).toMatchObject({
    GH_HOST: "broker.example.invalid",
    GH_ENTERPRISE_TOKEN: token,
    ANTHROPIC_BASE_URL: `${url}/gateway/claude`,
    ANTHROPIC_API_KEY: token,
    OPENAI_BASE_URL: `${url}/gateway/gpt/v1`,
    OPENAI_API_KEY: token,
    OPENROUTER_BASE_URL: `${url}/gateway/router/v1`,
    OPENROUTER_API_KEY: token,
  });
  expect(JSON.stringify(grant)).not.toContain(key);
  expect(grant.expiresAt).toBe(expiresAt);

  await grant.revoke(new AbortController().signal, "unsafe-canary");
  expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ["POST", "/v1/grants"],
    ["DELETE", `/v1/grants/${id}`],
  ]);
  expect(calls.every((call) => call.headers.get("authorization") === `Bearer ${key}`)).toBe(true);
  expect(calls.every((call) => call.redirect === "error")).toBe(true);
  expect(calls[0]!.headers.get("traceparent")).toBe(traceParent);
  expect(calls[1]!.headers.has("traceparent")).toBe(false);
});

test("GitHub Actions OIDC requests fresh per-call tokens and preserves GitHub's request query", async () => {
  let exchanges = 0;

  const auth = githubActionsOidc({
    audience: "fixture broker",
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example.invalid/token?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
    },
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer runner-token");
      expect([...new URL(request.url).searchParams]).toEqual([
        ["api-version", "2.0"],
        ["audience", "fixture broker"],
      ]);

      return Response.json({ value: `header.payload.signature-${++exchanges}` });
    },
  });

  const broker = createCredentialBroker({
    url,
    auth,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        `Bearer header.payload.signature-${exchanges}`,
      );

      return request.method === "POST"
        ? grantResponse(["gpt"])
        : new Response(null, { status: 204 });
    },
  });

  const grant = await broker.issue({ integrations: ["gpt"] });
  await broker.revoke(grant.id);
  expect(exchanges).toBe(2);
});

test("validates the token contract and sanitizes transport, auth, and HTTP failures", async () => {
  expect(() =>
    createCredentialBroker({ url: `${url}/some/path`, auth: { apiKey: key } }),
  ).toThrow();
  expect(() => createCredentialBroker({ url, auth: { apiKey: token } })).toThrow();

  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch() {
      return Response.json(
        { id, token: key, expiresAt, integrations: ["github"] },
        { status: 201 },
      );
    },
  });

  await expect(broker.issue({ integrations: ["github"] })).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
  await expect(broker.issue({ integrations: ["GITHUB"] })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });

  const failure = createCredentialBroker({
    url,
    auth: {
      async githubActionsOidc() {
        throw new Error(key);
      },
    },
  });

  await expect(failure.issue({ integrations: ["github"] })).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
    message: "Credential broker authentication failed",
  });

  const denied = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch() {
      return new Response(key, { status: 403 });
    },
  });

  await expect(denied.issue({ integrations: ["github"] })).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "Credential request was denied",
  });
});

test("classifies a broker grant HTTP 400 as invalid input and an OIDC HTTP 400 as authentication failure", async () => {
  const integrations = ["github-work", "github-tools"];
  const upstreamDetails = "fixture-error-detail-canary";

  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch(request) {
      expect(await request.json()).toEqual({ integrations, ttlSeconds: 900 });

      return new Response(upstreamDetails, { status: 400 });
    },
  });

  await expect(broker.issue({ integrations })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Credential broker rejected the grant request",
  });

  let brokerCalls = 0;

  const oidcBroker = createCredentialBroker({
    url,
    auth: githubActionsOidc({
      audience: "beachside-broker",
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example.invalid/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
      },
      async fetch() {
        return new Response(upstreamDetails, { status: 400 });
      },
    }),
    async fetch() {
      brokerCalls++;

      return new Response(null, { status: 500 });
    },
  });

  await expect(oidcBroker.issue({ integrations })).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
    message: "Credential broker authentication failed",
  });
  expect(brokerCalls).toBe(0);
});

test("cancellation bounds a fetch or OIDC provider that ignores its signal", async () => {
  const never = () => new Promise<never>(() => undefined);

  const brokers = [
    createCredentialBroker({ url, auth: { apiKey: key }, fetch: never }),
    createCredentialBroker({ url, auth: { githubActionsOidc: never } }),
  ];

  for (const broker of brokers) {
    const controller = new AbortController();
    const result = broker.issue({ integrations: ["github"] }, { signal: controller.signal });
    queueMicrotask(() => controller.abort(new Error(key)));
    await expect(result).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      message: "Credential grant request was cancelled",
    });
  }
});

test("real Git rewrites GitHub HTTPS remotes and scopes its credential helper to the broker", async () => {
  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch() {
      return grantResponse(["github"]);
    },
  });

  const grant = await broker.sandbox({ github: "github" }).acquire(new AbortController().signal);
  const home = mkdtempSync(join(tmpdir(), "beachside-broker-git-"));
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...grant.env };

  const git = (args: string[], input?: string) =>
    spawnSync("git", args, { cwd: home, env, input, encoding: "utf8" });

  try {
    expect(git(["init"]).status).toBe(0);
    expect(git(["remote", "add", "origin", "https://github.com/acme/repo.git"]).status).toBe(0);
    expect(git(["remote", "get-url", "origin"]).stdout.trim()).toBe(`${url}/acme/repo.git`);

    const credential = git(
      ["credential", "fill"],
      "protocol=https\nhost=broker.example.invalid\n\n",
    );

    expect(credential.status).toBe(0);
    expect(credential.stdout).toContain(`password=${token}\n`);
    expect(credential.stdout).toContain("username=x-access-token\n");
    const unrelated = git(["credential", "fill"], "protocol=https\nhost=example.invalid\n\n");
    expect(unrelated.stdout).not.toContain(token);

    // The executable is optional in CI. Test the generated host/token with real gh when installed.
    const gh = spawnSync("gh", ["auth", "token", "--hostname", grant.env.GH_HOST!], {
      cwd: home,
      env,
      encoding: "utf8",
    });

    if (!gh.error) {
      expect(gh.status).toBe(0);
      expect(gh.stdout.trim()).toBe(token);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GitHub Actions OIDC reports incomplete configuration before parsing the endpoint", () => {
  const endpoint = "https://runner.example.invalid/token";

  for (const options of [
    { audience: "broker", env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token" } },
    { audience: "broker", env: { ACTIONS_ID_TOKEN_REQUEST_URL: endpoint } },
    {
      audience: "",
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: endpoint,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
      },
    },
  ]) {
    expect(() => githubActionsOidc(options)).toThrow(
      "GitHub Actions OIDC configuration is incomplete",
    );
  }

  expect(() =>
    githubActionsOidc({
      audience: "broker",
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "http://not-https.invalid/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
      },
    }),
  ).toThrow("A valid HTTPS URL is required");
});

test("cancellation bounds the grant body after a successful response status", async () => {
  const controller = new AbortController();
  const bodyRead = Promise.withResolvers<void>();
  const bodyReleased = Promise.withResolvers<void>();
  let closeBody = () => {};

  let calls = 0;

  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch() {
      calls++;

      const body = new ReadableStream(
        {
          start(stream) {
            closeBody = () => stream.close();
            stream.enqueue(new TextEncoder().encode('{"token":'));
          },
          pull() {
            bodyRead.resolve();

            return bodyReleased.promise;
          },
        },
        { highWaterMark: 0 },
      );

      return new Response(body, { status: 201 });
    },
  });

  const result = broker.issue({ integrations: ["github"] }, { signal: controller.signal });

  try {
    await bodyRead.promise;
    controller.abort(new Error(key));
    await expect(result).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      message: "Credential grant request was cancelled",
    });
    expect(calls).toBe(1);
  } finally {
    closeBody();
    bodyReleased.resolve();
  }
});

test("maps configurable HTTP endpoints to caller-selected sandbox environment variables", async () => {
  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch(request) {
      const input = await request.json();

      expect(input).toEqual({ integrations: ["github", "custom"], ttlSeconds: 900 });

      return grantResponse(input.integrations);
    },
  });

  const endpoint = {
    integration: "custom",
    baseURLEnv: "PROVIDER_URL",
    apiKeyEnv: "PROVIDER_TOKEN",
  };

  const sandbox = broker.sandbox({ github: "github", endpoints: [endpoint] });
  const grant = await sandbox.acquire(new AbortController().signal);

  expect(grant.env.PROVIDER_URL).toBe(`${url}/gateway/custom`);
  expect(grant.env.PROVIDER_TOKEN).toBe(token);
  expect(grant.env.GH_ENTERPRISE_TOKEN).toBe(token);
  expect(() => broker.sandbox({ endpoints: [endpoint, endpoint] })).toThrow("Invalid or duplicate");
  expect(() =>
    broker.sandbox({
      github: "github",
      endpoints: [{ ...endpoint, apiKeyEnv: "GH_ENTERPRISE_TOKEN" }],
    }),
  ).toThrow("Invalid or duplicate");
  expect(() => broker.sandbox({ endpoints: [{ ...endpoint, baseURLEnv: "bad=name" }] })).toThrow(
    "Invalid or duplicate",
  );
});

test("uses each integration's reported kind, so provider shorthands work with generic HTTP integrations", async () => {
  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch(request) {
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const { integrations } = await request.json();

      return Response.json(
        {
          id,
          token,
          expiresAt,
          integrations,
          kinds: { openrouter: "http", gpt: "openai", work: "openai", gh: "github" },
        },
        { status: 201 },
      );
    },
  });

  const grant = await broker
    .sandbox({
      github: "gh",
      openrouter: "openrouter",
      openai: "gpt",
      endpoints: [{ integration: "work", baseURLEnv: "WORK_BASE_URL", apiKeyEnv: "WORK_KEY" }],
    })
    .acquire(new AbortController().signal);

  expect(grant.env).toMatchObject({
    OPENROUTER_BASE_URL: `${url}/gateway/openrouter`,
    OPENAI_BASE_URL: `${url}/gateway/gpt/v1`,
    WORK_BASE_URL: `${url}/gateway/work/v1`,
  });
  expect(grant.id).toBe(id);
  expect(grant.integrations).toEqual(["gh", "gpt", "openrouter", "work"]);
});

test("refuses a GitHub shorthand that names a non-GitHub integration and revokes the grant", async () => {
  const methods: string[] = [];

  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch(request) {
      methods.push(request.method);

      if (request.method === "DELETE") return new Response(null, { status: 204 });

      return Response.json(
        { id, token, expiresAt, integrations: ["router"], kinds: { router: "http" } },
        { status: 201 },
      );
    },
  });

  await expect(
    broker.sandbox({ github: "router" }).acquire(new AbortController().signal),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("router") });
  expect(methods).toEqual(["POST", "DELETE"]);
});

test("sets each integration passed by id up from its reported kind, and refuses ones it can't", async () => {
  const methods: string[] = [];

  const broker = createCredentialBroker({
    url,
    auth: { apiKey: key },
    async fetch(request) {
      methods.push(request.method);

      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const { integrations } = await request.json();

      return Response.json(
        {
          id,
          token,
          expiresAt,
          integrations,
          kinds: {
            claude: "anthropic",
            router: "openrouter",
            gh: "github",
            api: "http",
            gpt: "openai",
            work: "openai",
            anthropic: "http",
          },
        },
        { status: 201 },
      );
    },
  });

  const signal = new AbortController().signal;

  const grant = await broker
    .sandbox({ integrations: ["claude", "router", "gh", "api"] })
    .acquire(signal);

  expect(grant.env).toMatchObject({
    ANTHROPIC_BASE_URL: `${url}/gateway/claude`,
    ANTHROPIC_API_KEY: token,
    OPENROUTER_BASE_URL: `${url}/gateway/router/v1`,
    OPENROUTER_API_KEY: token,
    GH_ENTERPRISE_TOKEN: token,
    GIT_CONFIG_COUNT: "3",
    API_BASE_URL: `${url}/gateway/api`,
    API_API_KEY: token,
  });
  expect(methods).toEqual(["POST"]);

  for (const [integrations, message] of [
    [["anthropic", "claude"], "Two integrations would set ANTHROPIC_BASE_URL"],
    [["gpt", "work"], "Two integrations would set OPENAI_BASE_URL"],
  ] as const) {
    methods.length = 0;
    await expect(broker.sandbox({ integrations }).acquire(signal)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(message),
    });
    expect(methods).toEqual(["POST", "DELETE"]);
  }

  expect(() => broker.sandbox({ integrations: ["gh"], github: "gh" })).toThrow(
    "Invalid broker grant request",
  );
});

test("explains issuance refusals and accepts a loopback HTTP broker for local development", async () => {
  const broker = createCredentialBroker({
    url: "http://localhost:8787",
    auth: { apiKey: key },
    async fetch(request) {
      expect(request.url).toBe("http://localhost:8787/v1/grants");

      return Response.json(
        { error: "integration_forbidden", reason: "not_allowlisted", integrations: ["router"] },
        { status: 403 },
      );
    },
  });

  await expect(broker.issue({ integrations: ["router"] })).rejects.toMatchObject({
    code: "FORBIDDEN",
    reason: "not_allowlisted",
    integrations: ["router"],
    message: expect.stringContaining("issuer allow router"),
  });

  for (const remote of ["http://broker.example.com", "http://10.0.0.1"])
    expect(() => createCredentialBroker({ url: remote, auth: { apiKey: key } })).toThrow(
      "A valid HTTPS URL is required",
    );

  expect(() => broker.issue({ integrations: ["router"], ttlSeconds: 604_801 })).toThrow();
});
