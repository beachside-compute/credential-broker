import assert from "node:assert/strict";
import { createCredentialBroker } from "@beachside/credential-client";
import { runBrokerCli } from "@beachside/credential-client/cli";

const token = `bsg_${"9".repeat(64)}`;

const id = "685daa5a-0771-4ef8-9e41-3a5a913e7a04";

const key = "fixture_credential_broker_control_key";

const events = [];

const broker = createCredentialBroker({
  url: "https://broker.example.invalid",
  auth: { apiKey: key },
  async fetch(request) {
    assert.equal(request.headers.get("authorization"), `Bearer ${key}`);

    if (request.method === "DELETE") {
      assert.equal(new URL(request.url).pathname, `/v1/grants/${id}`);
      events.push("revoke");

      return new Response(null, { status: 204 });
    }

    assert.deepEqual(await request.json(), { integrations: ["gpt"], ttlSeconds: 900 });
    events.push("issue");

    return Response.json(
      { id, token, expiresAt: new Date(Date.now() + 60_000).toISOString(), integrations: ["gpt"] },
      { status: 201 },
    );
  },
});

const { signal } = new AbortController();

const grant = await broker.sandbox({ openai: "gpt" }).acquire(signal);

try {
  assert.deepEqual(grant.env, {
    OPENAI_API_KEY: token,
    OPENAI_BASE_URL: "https://broker.example.invalid/gateway/gpt/v1",
  });
} finally {
  await grant.revoke(signal);
}

assert.deepEqual(events, ["issue", "revoke"]);

const printed = [];

assert.equal(
  await runBrokerCli(["--version"], {
    env: {},
    stdout: (text) => printed.push(text),
    stderr: (text) => printed.push(text),
  }),
  0,
);

assert.match(printed.join(""), /^\d+\.\d+\.\d+/);

console.log(
  "Packed client configured and revoked a standalone sandbox grant, and ran the /cli export",
);
