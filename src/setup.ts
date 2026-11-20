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
import { terminalPrompt, type Ask } from "./terminal.js";
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

export async function setupIntegration(): Promise<BrokerIntegrationInput> {
  return terminalPrompt(
    "Integration setup needs a terminal. Use integration create --config-stdin for automation",
    "Integration setup cancelled",
    configureIntegration,
  );
}

export async function configureIntegration(
  ask: Ask,
  write: (message: string) => void,
): Promise<Extract<BrokerIntegrationInput, { kind: "http" }>> {
  for (const [index, preset] of presets.entries()) write(`${index + 1}. ${preset.name}\n`);
  const preset = presets[Number(await ask("Provider number: ")) - 1];

  if (!preset) return setupError("Choose a listed provider number");
  const id = (await ask(`Integration ID [${preset.id}]: `)).trim() || preset.id;

  if (!integrationName.test(id)) return setupError("Invalid broker integration identifier");

  let address = preset.baseURL;

  if (preset.id === "cloudflare") {
    const account = (await ask("Cloudflare account ID: ")).trim();
    const gateway = (await ask("Cloudflare gateway ID: ")).trim();

    if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-z0-9_-]{1,64}$/i.test(gateway))
      return setupError("Invalid Cloudflare account or gateway identifier");
    address = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/openai`;
  }

  const baseURL = endpointBaseURL(address ?? (await ask("Upstream HTTPS base URL: ")).trim());

  if (!baseURL) return setupError("Invalid upstream HTTPS base URL");

  const headers: BrokerEndpointHeader[] = [];
  const values = new Map<string, string>();

  const secret = async (name: string, prefix: string, label: string) => {
    if (!endpointSecretPrefix.test(prefix))
      return setupError("Secret prefix must contain at most 128 printable ASCII characters");
    const value = await ask(label, true);

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
      const name = (await ask("Header name (Enter to finish): ")).trim().toLowerCase();

      if (!name) break;

      if (!endpointHeaderName(name) || headers.some((header) => header.name === name))
        return setupError("Invalid, reserved or duplicate header name");

      const type = (await ask("Header type [secret/literal]: ")).trim().toLowerCase();

      if (!type || type === "secret") {
        const prefix = await ask("Secret prefix, including any space (Enter for none): ");
        await secret(name, prefix, "Secret value: ");
      } else if (type === "literal") {
        literal(name, await ask("Non-secret literal value: "));
      } else {
        return setupError("Choose secret or literal");
      }
    }
  } else if (preset.id === "anthropic") {
    await secret("x-api-key", "", "Anthropic API key: ");
    literal("anthropic-version", "2023-06-01");
  } else {
    if (preset.id === "kilo") {
      const organization = (await ask("Kilo organization ID (Enter to skip): ")).trim();

      if (organization) literal("x-kilocode-organizationid", organization);
    }

    await secret(
      "authorization",
      "Bearer ",
      preset.id === "cloudflare" ? "OpenAI API key: " : "Provider API key: ",
    );

    if (preset.id === "cloudflare")
      await secret("cf-aig-authorization", "Bearer ", "Cloudflare AI Gateway token: ");
  }

  write(
    `Create ${id} for ${baseURL} with headers ${headers.map(({ name }) => name).join(", ") || "(none)"}?\n`,
  );

  if ((await ask("Confirm [y/N]: ")).trim().toLowerCase() !== "y")
    return setupError("Integration setup cancelled");

  return {
    id,
    kind: "http",
    endpoint: { baseURL, headers },
    credential: { source: "encrypted-store", values: Object.fromEntries(values) },
  };
}
