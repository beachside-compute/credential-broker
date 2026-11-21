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
