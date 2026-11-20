import { expect, test } from "bun:test";
import { createCredentialBrokerAdmin } from "./index.js";
import type { BrokerIntegration } from "./index.js";

const url = "https://broker.example.invalid";

const apiKey = "fixture_separate_broker_admin_control_key";

const value = "synthetic-upstream-value";

const meta: BrokerIntegration = {
  id: "github-work",
  kind: "github",
  enabled: true,
  credentialSource: "encrypted-store",
  credentialVersion: 1,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
};

test("admin operations use their own credential and expose only integration metadata", async () => {
  const paths: string[] = [];

  const output = new Map([
    [
      "POST /v1/admin/integrations",
      Response.json({ ...meta, credential: { value } }, { status: 201 }),
    ],
    [
      "GET /v1/admin/integrations",
      Response.json({ integrations: [{ ...meta, credential: value }] }),
    ],
    ["GET /v1/admin/integrations/github-work", Response.json(meta)],
    [
      "PUT /v1/admin/integrations/github-work/credential",
      Response.json({ ...meta, credentialSource: "worker-secret", credentialVersion: 2 }),
    ],
    ["PATCH /v1/admin/integrations/github-work", Response.json({ ...meta, enabled: false })],
    ["DELETE /v1/admin/integrations/github-work", new Response(null, { status: 204 })],
  ]);

  const admin = createCredentialBrokerAdmin({
    url,
    apiKey,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(request.redirect).toBe("error");
      const route = `${request.method} ${new URL(request.url).pathname}`;
      paths.push(route);

      if (request.method === "POST")
        expect(await request.json()).toEqual({
          id: meta.id,
          kind: "github",
          credential: { source: "encrypted-store", value },
        });

      if (request.method === "PUT")
        expect(await request.json()).toEqual({
          source: "worker-secret",
          binding: "CREDENTIAL_GITHUB",
        });

      if (request.method === "PATCH") expect(await request.json()).toEqual({ enabled: false });

      return output.get(route)!;
    },
  });

  expect(
    await admin.integrations.create({
      id: meta.id,
      kind: "github",
      credential: { source: "encrypted-store", value },
    }),
  ).toEqual(meta);
  expect(await admin.integrations.list()).toEqual([meta]);
  expect(await admin.integrations.get(meta.id)).toEqual(meta);
  expect(
    await admin.integrations.rotate(meta.id, {
      source: "worker-secret",
      binding: "CREDENTIAL_GITHUB",
    }),
  ).toMatchObject({
    credentialSource: "worker-secret",
    credentialVersion: 2,
  });
  expect((await admin.integrations.setEnabled(meta.id, false)).enabled).toBe(false);
  await admin.integrations.delete(meta.id);
  expect(paths).toEqual([...output.keys()]);
});

test("grant eligibility starts empty, is replaced exactly, and filters extraneous response fields", async () => {
  let integrations: string[] = [];

  const admin = createCredentialBrokerAdmin({
    url,
    apiKey,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/admin/issuer-permissions");

      if (request.method === "PUT") integrations = (await request.json()).integrations;

      return Response.json({ integrations, accidentallyIncluded: apiKey });
    },
  });

  expect(await admin.issuerPermissions.get()).toEqual({ integrations: [] });
  expect(await admin.issuerPermissions.set(["github-work", "claude"])).toEqual({
    integrations: ["github-work", "claude"],
  });
  expect(await admin.issuerPermissions.set([])).toEqual({ integrations: [] });
  await expect(admin.issuerPermissions.set(["github-work", "github-work"])).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("admin validates inputs, never exposes arbitrary error bodies or accepts malformed metadata", async () => {
  expect(() => createCredentialBrokerAdmin({ url, apiKey: `bsg_${"f".repeat(64)}` })).toThrow(
    "Invalid broker API key",
  );

  const never = createCredentialBrokerAdmin({
    url,
    apiKey,
    async fetch() {
      throw new Error(value);
    },
  });

  await expect(never.integrations.get("../grants")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    never.integrations.rotate(meta.id, { source: "encrypted-store", value: `${value}\n` }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Invalid broker integration credential",
  });
  await expect(
    never.integrations.rotate(meta.id, { source: "worker-secret", binding: "BROKER_ADMIN_KEY" }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

  for (const [status, code] of [
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMIT"],
    [503, "UNAVAILABLE"],
  ] as const) {
    const client = createCredentialBrokerAdmin({
      url,
      apiKey,
      async fetch() {
        return new Response(value, { status });
      },
    });

    const error = await client.integrations.get(meta.id).catch((error) => error);

    expect(error.code).toBe(code);
    expect(error.message).not.toContain(value);
    expect(error.message).not.toContain(apiKey);
  }

  const malformed = createCredentialBrokerAdmin({
    url,
    apiKey,
    async fetch() {
      return Response.json({ ...meta, id: "different" });
    },
  });

  await expect(malformed.integrations.get(meta.id)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
});
