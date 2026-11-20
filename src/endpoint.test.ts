import { expect, test } from "bun:test";
import { endpointBaseURL, safeEndpointPath } from "./endpoint";
import { configureIntegration } from "./setup";

const origin = "https://upstream.example.com";

test("validates normalized URL length and rejects ambiguous path and host forms", () => {
  for (const value of [
    "https://127.0.0.1",
    "https://[::1]",
    "https://example.local",
    "https://example.internal",
    "https://localhost",
    `${origin}/${"a".repeat(2048)}`,
    `${origin}/${"é".repeat(400)}`,
  ])
    expect(endpointBaseURL(value)).toBeUndefined();

  for (const path of ["/..;/x", "/..%3b/x", "/..%20/x", "/%2e%2e%3b/x", "/foo./x", "/foo%C2%A0/x"])
    expect(safeEndpointPath(path)).toBe(false);

  expect(endpointBaseURL(`${origin}/café`)).toBe(`${origin}/caf%C3%A9`);
  expect(safeEndpointPath("/a%20b/v1.2")).toBe(true);
});

test("Anthropic wizard configures the version, masks the key and rejects malformed inputs before confirmation", async () => {
  const answers = ["6", "", "fixture-anthropic-key", "y"];
  const prompts: { label: string; secret: boolean }[] = [];
  const output: string[] = [];

  const config = await configureIntegration(
    async (label, secret = false) => {
      prompts.push({ label, secret });

      return answers.shift() ?? "";
    },
    (message) => output.push(message),
  );

  expect(config.endpoint).toEqual({
    baseURL: "https://api.anthropic.com",
    headers: [
      { name: "x-api-key", secret: true },
      { name: "anthropic-version", value: "2023-06-01" },
    ],
  });
  expect(prompts.find(({ label }) => label.startsWith("Anthropic API key"))?.secret).toBe(true);
  expect(output.join("\n")).not.toContain("fixture-anthropic-key");

  for (const { input, error } of [
    { input: ["6", "", " invalid"], error: "Secret must contain" },
    {
      input: ["7", "", origin, "x-secret", "secret", "x".repeat(129)],
      error: "Secret prefix must contain",
    },
    {
      input: ["7", "", origin, "x-literal", "literal", "x".repeat(1025)],
      error: "Literal header value must contain",
    },
  ]) {
    await expect(
      configureIntegration(
        async () => input.shift() ?? "",
        () => {},
      ),
    ).rejects.toThrow(error);
  }
});
