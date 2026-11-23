import { expect, test } from "bun:test";
import { formatDuration, parseDuration, runBrokerCli } from "./commands";

test("parses grant lifetimes from seconds to seven days", () => {
  expect(parseDuration("900")).toBe(900);
  expect(parseDuration("15m")).toBe(900);
  expect(parseDuration("12h")).toBe(43_200);
  expect(parseDuration("7d")).toBe(604_800);

  for (const value of ["0", "8d", "604801", "1.5h", "-1", "1w"])
    expect(() => parseDuration(value)).toThrow("--ttl must be 1s to 7d");

  expect(formatDuration(604_800)).toBe("7d");
  expect(formatDuration(5_400)).toBe("90m");
  expect(formatDuration(61)).toBe("61s");
});

test("reports usage errors with the embedding prefix and the shared exit codes", async () => {
  const out: string[] = [];
  const err: string[] = [];

  const io = {
    env: {},
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    prefix: "beachside broker",
  };

  expect(await runBrokerCli(["--help"], io)).toBe(0);
  expect(out.join("\n")).toContain("Usage: beachside broker <command>");
  expect(await runBrokerCli(["grant", "list"], io)).toBe(2);
  expect(err.at(-1)).toContain("BEACHSIDE_BROKER_URL");
  expect(await runBrokerCli(["grant", "list", "--url", "https://b.example.com"], io)).toBe(2);
  expect(err.at(-1)).toContain("issuer key");
  expect(await runBrokerCli(["issuer", "allow", "--ttl", "1m", "x"], io)).toBe(2);
  expect(err.at(-1)).toContain("--ttl is not accepted by issuer allow");
  expect(await runBrokerCli(["nope"], { ...io, stderr: () => {} })).toBe(2);
  expect(await runBrokerCli(["--version", "--json"], io)).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toHaveProperty("version");
});

test("asks for the key a command needs when no setting supplies it", async () => {
  const seen: (string | null)[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization"));

      return new URL(request.url).pathname === "/v1/grants"
        ? Response.json({ grants: [] })
        : Response.json({ apiVersion: 2, role: "admin", limits: { maxGrantTtlSeconds: 604_800 } });
    },
  });

  try {
    const asked: string[] = [];

    const io = {
      env: { BEACHSIDE_BROKER_URL: `http://127.0.0.1:${server.port}` },
      stdout: () => {},
      stderr: () => {},
      promptKey: async (role: "admin" | "issuer") => {
        asked.push(role);

        return `typed-${role}-key-${"k".repeat(32)}`;
      },
    };

    expect(await runBrokerCli(["status"], io)).toBe(0);
    expect(await runBrokerCli(["grant", "list"], io)).toBe(0);
    expect(asked).toEqual(["admin", "issuer"]);
    expect(seen).toEqual([
      `Bearer typed-admin-key-${"k".repeat(32)}`,
      `Bearer typed-issuer-key-${"k".repeat(32)}`,
    ]);
  } finally {
    await server.stop(true);
  }
});

test("plants a canary as the variables a sandbox grant would set, and adds alert destinations", async () => {
  const token = `bsg_${"a".repeat(64)}`;
  const bodies: unknown[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());

      return new URL(request.url).pathname === "/v1/admin/canaries"
        ? Response.json(
            {
              id: "0b0e6f6c-5f4e-4c3e-8a9b-1c2d3e4f5a6b",
              token,
              expiresAt: "2026-11-30T00:00:00.000Z",
              integrations: ["github", "openrouter"],
              kinds: { github: "github", openrouter: "openrouter" },
            },
            { status: 201 },
          )
        : Response.json(
            {
              id: "pager",
              kind: "webhook",
              host: "alerts.example.com",
              headerNames: ["Authorization"],
              createdAt: "2026-11-23T00:00:00.000Z",
              lastAlertAt: null,
              lastDeliveryAt: null,
              lastStatus: null,
              signingSecret: "whsec_c2VjcmV0",
            },
            { status: 201 },
          );
    },
  });

  try {
    const out: string[] = [];
    const origin = `http://127.0.0.1:${server.port}`;

    const io = {
      env: {
        BEACHSIDE_BROKER_URL: origin,
        BEACHSIDE_BROKER_ADMIN_KEY: `admin-key-${"k".repeat(32)}`,
        PAGER_TOKEN: "Bearer from-env",
      },
      stdout: (text: string) => out.push(text),
      stderr: () => {},
    };

    expect(
      await runBrokerCli(
        ["canary", "issue", "github", "openrouter", "--label", "decoy", "--env"],
        io,
      ),
    ).toBe(0);
    expect(bodies.at(-1)).toEqual({ integrations: ["github", "openrouter"], label: "decoy" });
    expect(out.at(-1)).toContain(`OPENROUTER_BASE_URL=${origin}/gateway/openrouter/v1`);
    expect(out.at(-1)).toContain(`OPENROUTER_API_KEY=${token}`);
    expect(out.at(-1)).toContain(`GH_ENTERPRISE_TOKEN=${token}`);

    expect(
      await runBrokerCli(
        [
          "alert",
          "add",
          "webhook",
          "pager",
          "--to",
          "https://alerts.example.com/hook",
          "--header",
          "Authorization=env:PAGER_TOKEN",
        ],
        io,
      ),
    ).toBe(0);
    expect(bodies.at(-1)).toEqual({
      id: "pager",
      kind: "webhook",
      url: "https://alerts.example.com/hook",
      headers: { Authorization: "Bearer from-env" },
    });
    expect(out.at(-1)).toContain("whsec_c2VjcmV0");
    expect(
      await runBrokerCli(["alert", "add", "slack", "chat", "--to", "https://example.com/x"], io),
    ).toBe(2);
  } finally {
    await server.stop(true);
  }
});
