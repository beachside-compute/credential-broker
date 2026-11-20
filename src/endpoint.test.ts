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

function fixturePrompter(input: string[]): Parameters<typeof configureIntegration>[0] & {
  textPrompts: { message: string; defaultValue?: string }[];
  passwords: string[];
  confirmations: string[];
} {
  const textPrompts: { message: string; defaultValue?: string }[] = [];
  const passwords: string[] = [];
  const confirmations: string[] = [];
  const next = () => input.shift() ?? "";

  return {
    textPrompts,
    passwords,
    confirmations,
    async select(_, options) {
      const selected = next();
      const choice = options.find(({ value }) => value === selected);

      if (!choice) throw new Error("The fixture must select a listed choice");

      return choice.value;
    },
    async text(message, defaultValue) {
      textPrompts.push({ message, defaultValue });

      return next();
    },
    async password(message) {
      passwords.push(message);

      return next();
    },
    async confirm(message) {
      confirmations.push(message);

      return next() === "y";
    },
  };
}

test("OpenRouter setup explains the integration ID and defaults to openrouter on Enter", async () => {
  const prompts = fixturePrompter(["openrouter", "", "fixture-openrouter-key", "y"]);
  const config = await configureIntegration(prompts);

  expect(prompts.textPrompts).toEqual([
    {
      message: "Integration ID (name Beachside uses to request access)",
      defaultValue: "openrouter",
    },
  ]);
  expect(config.id).toBe("openrouter");
  expect(prompts.confirmations[0]).toContain("Create openrouter");

  const second = fixturePrompter(["openrouter", "router-work", "fixture-openrouter-key", "y"]);
  expect((await configureIntegration(second)).id).toBe("router-work");
});

test("Anthropic wizard configures the version, masks the key and rejects malformed inputs before confirmation", async () => {
  const prompts = fixturePrompter(["anthropic", "", "fixture-anthropic-key", "y"]);
  const config = await configureIntegration(prompts);

  expect(config.endpoint).toEqual({
    baseURL: "https://api.anthropic.com",
    headers: [
      { name: "x-api-key", secret: true },
      { name: "anthropic-version", value: "2023-06-01" },
    ],
  });
  expect(prompts.passwords).toEqual(["Anthropic API key"]);
  expect(prompts.confirmations.join("\n")).toContain("x-api-key");
  expect(prompts.confirmations.join("\n")).not.toContain("fixture-anthropic-key");

  for (const { input, error } of [
    { input: ["anthropic", "", " invalid"], error: "Secret must contain" },
    {
      input: ["custom", "", origin, "x-secret", "secret", "x".repeat(129)],
      error: "Secret prefix must contain",
    },
    {
      input: ["custom", "", origin, "x-literal", "literal", "x".repeat(1025)],
      error: "Literal header value must contain",
    },
    {
      input: ["anthropic", "", "fixture-anthropic-key", "n"],
      error: "Integration setup cancelled",
    },
  ]) {
    await expect(configureIntegration(fixturePrompter(input))).rejects.toThrow(error);
  }
});
