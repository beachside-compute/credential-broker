export type BrokerEndpointHeader =
  | { name: string; value: string }
  | { name: string; secret: true; prefix?: string };

export interface BrokerEndpoint {
  baseURL: string;
  headers: BrokerEndpointHeader[];
}

export const maxEndpointHeaders = 8;

export const endpointSecretValue = /^[\x21-\x7e](?:[\x20-\x7e]{0,4094}[\x21-\x7e])?$/;

export const endpointSecretPrefix = /^[\x20-\x7e]{0,128}$/;

export const endpointLiteralValue = /^[\x20-\x7e]{0,1024}$/;

const blockedHeader =
  /^(?:accept-encoding|baggage|cdn-loop|connection|content-length|cookie2?|expect|forwarded|host|keep-alive|set-cookie2?|te|trailer|transfer-encoding|upgrade|via|grpc-trace-bin|sentry-trace|true-client-ip|traceparent|tracestate|x-client-ip|x-original-ip|x-original-url|x-rewrite-url|x-real-ip|x-http-method(?:-override)?|x-method-override)$|^(?:proxy-|sec-|x-forwarded-|x-b3-|x-datadog-|cf-(?!aig-))/i;

const headerName = /^[!#$%&'*+.^_`|~\w-]{1,64}$/;

export function reservedEndpointHeader(name: string): boolean {
  return blockedHeader.test(name);
}

export function endpointHeaderName(name: string): boolean {
  return headerName.test(name) && !reservedEndpointHeader(name);
}

export function safeEndpointPath(path: string): boolean {
  if (path === "") return true;

  if (!path.startsWith("/") || /\/\/|[\\\s]|%(?:2f|5c|25)/i.test(path) || hasControl(path))
    return false;

  try {
    return path.split("/").every((segment) => {
      const value = decodeURIComponent(segment);

      return !value.includes(";") && !/[.\s]$/.test(value) && !hasControl(value);
    });
  } catch {
    return false;
  }
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) return true;
  }

  return false;
}

export function endpointBaseURL(value: string): string | undefined {
  const raw = value.match(/^https:\/\/([^/?#\\\s]+)(\/[^?#]*)?$/i);

  if (!raw || raw[1].includes("@") || value.length > 2048 || !safeEndpointPath(raw[2] ?? ""))
    return;
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return;
  }

  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(url.hostname) ||
    /\.(?:local|localhost|internal|test|invalid|example)$/i.test(url.hostname)
  )
    return;

  const normalized = `${url.origin}${url.pathname.replace(/\/$/, "")}`;

  return normalized.length <= 2048 ? normalized : undefined;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- Normalize endpoint configuration at the HTTP and CLI trust boundaries. */

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse untrusted configuration.
export function normalizeEndpoint(input: unknown): BrokerEndpoint | undefined {
  if (!input || typeof input !== "object" || !("baseURL" in input && "headers" in input)) return;

  if (typeof input.baseURL !== "string" || !Array.isArray(input.headers)) return;

  const baseURL = endpointBaseURL(input.baseURL);

  if (!baseURL || input.headers.length > maxEndpointHeaders) return;

  const headers: BrokerEndpointHeader[] = [];
  const names = new Set<string>();

  for (const header of input.headers) {
    if (!header || typeof header !== "object" || typeof header.name !== "string") return;

    const name = header.name.toLowerCase();

    if (!endpointHeaderName(name) || names.has(name)) return;
    names.add(name);

    if (header.secret === true && !("value" in header)) {
      if (header.prefix === undefined) headers.push({ name, secret: true });
      else if (typeof header.prefix === "string" && endpointSecretPrefix.test(header.prefix))
        headers.push({ name, secret: true, prefix: header.prefix });
      else return;
    } else if (
      !("secret" in header || "prefix" in header) &&
      typeof header.value === "string" &&
      endpointLiteralValue.test(header.value)
    )
      headers.push({ name, value: header.value });
    else return;
  }

  return { baseURL, headers };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse untrusted credential input or decoded envelope.
export function normalizeEndpointValues(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;

  const entries = Object.entries(input);

  if (entries.length > maxEndpointHeaders) return;

  const values = new Map<string, string>();

  for (const [header, value] of entries) {
    const name = header.toLowerCase();

    if (
      values.has(name) ||
      !endpointHeaderName(name) ||
      typeof value !== "string" ||
      !endpointSecretValue.test(value)
    )
      return;
    values.set(name, value);
  }

  return Object.fromEntries(values);
}

export function matchingEndpointValues(
  endpoint: BrokerEndpoint,
  values: Record<string, string>,
  mode: "full" | "partial",
): boolean {
  const slots = endpoint.headers.filter((header) => "secret" in header).map(({ name }) => name);
  const names = Object.keys(values);

  return (
    names.every((name) => slots.includes(name)) &&
    (mode === "full" ? names.length === slots.length : names.length > 0 || slots.length === 0)
  );
}
