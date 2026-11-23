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
