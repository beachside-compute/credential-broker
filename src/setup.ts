import * as clack from "@clack/prompts";
import type { BrokerIntegrationInput } from "./admin.js";
import {
  endpointBaseURL,
  endpointHeaderName,
  endpointLiteralValue,
  endpointSecretPrefix,
  endpointSecretValue,
  maxEndpointHeaders,
  type BrokerEndpointHeader,
} from "./endpoint.js";
import { CredentialBrokerError, integrationName } from "./transport.js";

const presets: readonly { id: string; name: string; baseURL?: string }[] = [
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "kilo", name: "Kilo AI Gateway", baseURL: "https://ai-gateway.kilo.ai/api/v1" },
  { id: "vercel", name: "Vercel AI Gateway", baseURL: "https://ai-gateway.vercel.sh/v1" },
  { id: "cloudflare", name: "Cloudflare AI Gateway (OpenAI provider)" },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", baseURL: "https://api.anthropic.com" },
  { id: "custom", name: "Custom HTTPS endpoint" },
];

function setupError(message: string): never {
  throw new CredentialBrokerError("INVALID_ARGUMENT", message);
}

interface IntegrationPrompter {
  select<Value>(message: string, options: clack.Option<Value>[]): Promise<Value>;
  text(message: string, defaultValue?: string): Promise<string>;
  password(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}

export async function setupIntegration(): Promise<BrokerIntegrationInput> {
  const { stdin: input, stderr: output } = process;

  if (!input.isTTY || !output.isTTY)
    return setupError(
      "Integration setup needs a terminal. Use integration create --config-stdin for automation",
    );

  const common = { input, output };

  const answer = <Value>(value: Value | typeof clack.CANCEL_SYMBOL): Value => {
    if (clack.isCancel(value)) return setupError("Integration setup cancelled");

    return value;
  };

  clack.intro("Beachside broker integration setup", common);

  try {
    return await configureIntegration({
      async select(message, options) {
        return answer(await clack.select({ ...common, message, options }));
      },
      async text(message, defaultValue) {
        const placeholder = defaultValue && `Enter for ${defaultValue}, or type a unique ID`;

        return answer(await clack.text({ ...common, message, placeholder, defaultValue }));
      },
      async password(message) {
        return answer(await clack.password({ ...common, message }));
      },
      async confirm(message) {
        return answer(await clack.confirm({ ...common, message, initialValue: true }));
      },
    });
  } finally {
    input.pause();
  }
}

export async function configureIntegration({
  select,
  text,
  password,
  confirm,
}: IntegrationPrompter): Promise<Extract<BrokerIntegrationInput, { kind: "http" }>> {
  const selected = await select(
    "Choose a provider",
    presets.map(({ id, name }) => ({ value: id, label: name })),
  );

  const preset = presets.find(({ id }) => id === selected);

  if (!preset) return setupError("Choose a listed provider");

  const id =
    (await text("Integration ID (name Beachside uses to request access)", preset.id)).trim() ||
    preset.id;

  if (!integrationName.test(id)) return setupError("Invalid broker integration identifier");

  let address = preset.baseURL;

  if (preset.id === "cloudflare") {
    const account = (await text("Cloudflare account ID")).trim();
    const gateway = (await text("Cloudflare gateway ID")).trim();

    if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-z0-9_-]{1,64}$/i.test(gateway))
      return setupError("Invalid Cloudflare account or gateway identifier");
    address = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/openai`;
  }

  const baseURL = endpointBaseURL(address ?? (await text("Upstream HTTPS base URL")).trim());

  if (!baseURL) return setupError("Invalid upstream HTTPS base URL");

  const headers: BrokerEndpointHeader[] = [];
  const values = new Map<string, string>();

  const secret = async (name: string, prefix: string, label: string) => {
    if (!endpointSecretPrefix.test(prefix))
      return setupError("Secret prefix must contain at most 128 printable ASCII characters");
    const value = await password(label);

    if (!endpointSecretValue.test(value))
      return setupError(
        "Secret must contain 1 to 4096 printable ASCII characters without leading or trailing space",
      );
    headers.push({ name, secret: true, ...(prefix && { prefix }) });
    values.set(name, value);
  };

  const literal = (name: string, value: string) => {
    if (!endpointLiteralValue.test(value))
      return setupError(
        "Literal header value must contain at most 1024 printable ASCII characters",
      );
    headers.push({ name, value });
  };

  if (preset.id === "custom") {
    while (headers.length < maxEndpointHeaders) {
      const name = (await text("Header name (Enter to finish)")).trim().toLowerCase();

      if (!name) break;

      if (!endpointHeaderName(name) || headers.some((header) => header.name === name))
        return setupError("Invalid, reserved or duplicate header name");

      const type = await select("Header type", [
        { value: "secret", label: "Secret" },
        { value: "literal", label: "Literal" },
      ]);

      if (type === "secret") {
        const prefix = await text("Secret prefix, including any space (Enter for none)");
        await secret(name, prefix, "Secret value");
      } else {
        literal(name, await text("Non-secret literal value"));
      }
    }
  } else if (preset.id === "anthropic") {
    await secret("x-api-key", "", "Anthropic API key");
    literal("anthropic-version", "2023-06-01");
  } else {
    if (preset.id === "kilo") {
      const organization = (await text("Kilo organization ID (Enter to skip)")).trim();

      if (organization) literal("x-kilocode-organizationid", organization);
    }

    await secret(
      "authorization",
      "Bearer ",
      preset.id === "cloudflare" ? "OpenAI API key" : "Provider API key",
    );

    if (preset.id === "cloudflare")
      await secret("cf-aig-authorization", "Bearer ", "Cloudflare AI Gateway token");
  }

  const headerNames = headers.map(({ name }) => name).join(", ") || "(none)";

  if (!(await confirm(`Create ${id} for ${baseURL} with headers ${headerNames}?`)))
    return setupError("Integration setup cancelled");

  return {
    id,
    kind: "http",
    endpoint: { baseURL, headers },
    credential: { source: "encrypted-store", values: Object.fromEntries(values) },
  };
}
