/** Model gateways the reviewer can use, both reached through the credential broker. */
export type Gateway = "kilo" | "openrouter";

export const DEFAULT_GATEWAY: Gateway = "kilo";

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/**
 * Each gateway is one broker integration. The grant sets `<PREFIX>_BASE_URL` (the broker's
 * OpenAI-compatible base for it) and `<PREFIX>_API_KEY` (the grant token) in every command.
 * `kilo` is what `beachside broker integration setup` creates for Kilo AI Gateway; `openrouter`
 * works whether the integration is the `openrouter` kind or an HTTP endpoint.
 */
export const GATEWAYS = {
  kilo: { name: "Kilo AI Gateway", integration: "kilo", prefix: "KILO" },
  openrouter: { name: "OpenRouter", integration: "openrouter", prefix: "OPENROUTER" },
} as const satisfies Record<Gateway, { name: string; integration: string; prefix: string }>;

export function selectGateway(env: Record<string, string | undefined>) {
  const value = env.REVIEW_GATEWAY?.trim() || DEFAULT_GATEWAY;

  if (value !== "kilo" && value !== "openrouter")
    throw new Error(`REVIEW_GATEWAY must be kilo or openrouter, not ${JSON.stringify(value)}.`);

  const gateway = GATEWAYS[value];

  return {
    id: value,
    ...gateway,
    integration: env.REVIEW_GATEWAY_INTEGRATION?.trim() || gateway.integration,
    model: env.REVIEW_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export type SelectedGateway = ReturnType<typeof selectGateway>;

/**
 * A Node script, run in the sandbox, that writes Pi's `models.json` from the grant's variables.
 * The base URL only exists in the sandbox's command environment, and Pi reads the key itself
 * through `$<PREFIX>_API_KEY`, so neither value passes through this process.
 */
export function modelsScript(gateway: SelectedGateway, path: string) {
  const config = {
    providers: {
      [gateway.id]: {
        name: gateway.name,
        api: "openai-completions",
        apiKey: `$${gateway.prefix}_API_KEY`,
        models: [
          {
            id: gateway.model,
            name: gateway.model,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 8_192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              maxTokensField: "max_tokens",
              supportsDeveloperRole: false,
              supportsStore: false,
            },
          },
        ],
      },
    },
  };

  return [
    'const fs = require("node:fs");',
    `const base = process.env[${JSON.stringify(`${gateway.prefix}_BASE_URL`)}];`,
    `if (!base) { console.error(${JSON.stringify(`The grant did not set ${gateway.prefix}_BASE_URL; check the ${gateway.integration} integration.`)}); process.exit(1); }`,
    `const config = ${JSON.stringify(config)};`,
    `config.providers[${JSON.stringify(gateway.id)}].baseUrl = base;`,
    `fs.mkdirSync(${JSON.stringify(path.slice(0, path.lastIndexOf("/")))}, { recursive: true, mode: 0o700 });`,
    `fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify(config, null, 2), { mode: 0o600 });`,
  ].join("\n");
}
