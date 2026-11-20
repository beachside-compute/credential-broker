import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { BrokerIntegrationInput } from "./admin.js";
import {
  endpointBaseURL,
  endpointHeaderName,
  maxEndpointHeaders,
  type BrokerEndpointHeader,
} from "./endpoint.js";
import { CredentialBrokerError, integrationName } from "./transport.js";

const presets = [
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

type Ask = (label: string, secret?: boolean) => Promise<string>;

export async function setupIntegration(): Promise<BrokerIntegrationInput> {
  const { stdin, stderr } = process;

  if (!stdin.isTTY || !stderr.isTTY)
    return setupError(
      "Integration setup needs a terminal. Use integration create --config-stdin for automation",
    );

  let masked = false;

  const output = new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      if (masked) callback();
      else stderr.write(chunk, callback);
    },
  });

  const prompt = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  const signal = new AbortController();
  prompt.on("SIGINT", () => signal.abort());
  prompt.on("close", () => signal.abort());

  const ask: Ask = async (label, secret = false) => {
    stderr.write(label);
    masked = secret;

    try {
      return await prompt.question("", { signal: signal.signal });
    } catch {
      return setupError("Integration setup cancelled");
    } finally {
      masked = false;

      if (secret) stderr.write("\n");
    }
  };

  try {
    for (const [index, preset] of presets.entries()) stderr.write(`${index + 1}. ${preset.name}\n`);
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
      headers.push({ name, secret: true, ...(prefix && { prefix }) });
      values.set(name, await ask(label, true));
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
          headers.push({ name, value: await ask("Non-secret literal value: ") });
        } else {
          return setupError("Choose secret or literal");
        }
      }
    } else if (preset.id === "anthropic") {
      await secret("x-api-key", "", "Anthropic API key: ");
    } else {
      if (preset.id === "kilo") {
        const organization = (await ask("Kilo organization ID (Enter to skip): ")).trim();

        if (organization) headers.push({ name: "x-kilocode-organizationid", value: organization });
      }

      await secret(
        "authorization",
        "Bearer ",
        preset.id === "cloudflare" ? "OpenAI API key: " : "Provider API key: ",
      );

      if (preset.id === "cloudflare")
        await secret("cf-aig-authorization", "Bearer ", "Cloudflare AI Gateway token: ");
    }

    stderr.write(
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
  } finally {
    prompt.close();
  }
}
