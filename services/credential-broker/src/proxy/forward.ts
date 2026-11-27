import type { BrokerEndpointHeader } from "../../../../src/endpoint";
import { reservedEndpointHeader } from "../../../../src/endpoint";
import type { ResolvedCredential } from "../credentials/source";
import { brokerIntegration } from "../integrations/definitions";
import { brokerLink } from "./routes";
import type { Route } from "./routes";

const clientHeaders = [
  "accept",
  "content-encoding",
  "content-type",
  "git-protocol",
  "if-modified-since",
  "if-none-match",
  "anthropic-beta",
  "anthropic-version",
  "x-github-api-version",
  "idempotency-key",
];

const upstreamHeaders = [
  "content-type",
  "content-encoding",
  "date",
  "etag",
  "last-modified",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "x-ratelimit-used",
];

export function failure(
  status: number,
  error: string,
  challenge = false,
  detail?: { reason: string; integrations: string[] },
): Response {
  const headers = new Headers({ "cache-control": "no-store" });

  if (challenge) headers.set("www-authenticate", 'Basic realm="Beachside Git"');

  return Response.json({ error, ...detail }, { status, headers });
}

export async function upstream(
  request: Request,
  target: Route,
  credential: ResolvedCredential | { values: Record<string, string> },
  grant: string,
): Promise<Response> {
  const headers =
    "values" in credential
      ? endpointHeaders(
          request.headers,
          target.integration.endpoint?.headers ?? [],
          credential.values,
          grant,
        )
      : copyHeaders(request.headers, clientHeaders);

  if (!headers.has("user-agent")) headers.set("user-agent", "Beachside-Credential-Broker/0.0.0");
  headers.set("accept-encoding", "identity");

  if ("value" in credential) {
    const integration = brokerIntegration(target.integration.kind);

    if (!("authorize" in integration)) return failure(503, "credential_unavailable");
    integration.authorize(headers, credential.value, target.type);
  }

  // No retries. In particular, a transport error says nothing about whether a write landed.
  const response = await fetch(target.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    signal: request.signal,
  });

  const responseHeaders =
    "values" in credential
      ? endpointResponseHeaders(
          response.headers,
          target.integration.endpoint?.headers ?? [],
          credential.values,
        )
      : copyHeaders(response.headers, upstreamHeaders);

  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("content-security-policy", "default-src 'none'; sandbox");

  if (response.status === 401 || response.status === 407) {
    await response.body?.cancel();

    return failure(502, "upstream_authentication_failed");
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");

    const safe =
      location && ["GET", "HEAD"].includes(request.method)
        ? brokerLink(location, target)
        : undefined;

    await response.body?.cancel();

    if (!safe) return failure(502, "upstream_redirect_blocked");
    responseHeaders.delete("content-encoding");
    responseHeaders.set("location", safe);

    return new Response(null, { status: response.status, headers: responseHeaders });
  }

  if (target.type === "api") {
    const pagination = response.headers.get("link");

    if (pagination) {
      const links = [];

      for (const link of pagination.matchAll(/<([^>]+)>;\s*rel="(next|prev|first|last)"/g)) {
        const safe = brokerLink(link[1], target);

        if (safe) links.push(`<${new URL(safe, request.url).href}>; rel="${link[2]}"`);
      }

      if (links.length) responseHeaders.set("link", links.join(", "));
    }
  }

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
    encodeBody: "manual",
  });
}

function connectionHeaders(headers: Headers): ReadonlySet<string> {
  return new Set(
    headers
      .get("connection")
      ?.toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  );
}

export function endpointHeaders(
  incoming: Headers,
  configured: readonly BrokerEndpointHeader[],
  values: Record<string, string>,
  grant: string,
): Headers {
  const headers = new Headers();
  const nominated = connectionHeaders(incoming);

  // Delete every transport/identity header and any alternate copy of the bearer value.
  for (const [name, value] of incoming) {
    if (
      name === "authorization" ||
      name === "x-api-key" ||
      name.startsWith("cf-") ||
      reservedEndpointHeader(name) ||
      nominated.has(name) ||
      name.includes(grant) ||
      value.includes(grant)
    )
      continue;

    headers.set(name, value);
  }

  for (const header of configured) {
    headers.set(
      header.name,
      "secret" in header ? `${header.prefix ?? ""}${values[header.name]}` : header.value,
    );
  }

  return headers;
}

const endpointResponseBlocked = new Set([
  "alt-svc",
  "authorization",
  "clear-site-data",
  "content-location",
  "link",
  "location",
  "refresh",
  "service-worker-allowed",
  "www-authenticate",
  "x-api-key",
]);

export function endpointResponseHeaders(
  incoming: Headers,
  configured: readonly BrokerEndpointHeader[],
  values: Record<string, string>,
): Headers {
  const nominated = connectionHeaders(incoming);

  const secrets = configured.flatMap((header) => {
    if (!("secret" in header)) return [];
    const raw = values[header.name];

    return [{ raw, injected: `${header.prefix ?? ""}${raw}` }];
  });

  const headers = new Headers();

  for (const [name, value] of incoming) {
    if (
      reservedEndpointHeader(name) ||
      name.startsWith("cf-") ||
      endpointResponseBlocked.has(name) ||
      nominated.has(name) ||
      Object.hasOwn(values, name) ||
      secrets.some(
        ({ raw, injected }) =>
          value === raw ||
          (raw.length >= 8 && (value.includes(raw) || name.includes(raw))) ||
          (injected !== raw && value.includes(injected)),
      )
    )
      continue;

    headers.set(name, value);
  }

  return headers;
}

function copyHeaders(source: Headers, allowed: string[]): Headers {
  const headers = new Headers();

  for (const name of allowed) {
    const value = source.get(name);

    if (value !== null) headers.set(name, value);
  }

  return headers;
}

export function withCompletion(response: Response, complete: (failed?: boolean) => void): Response {
  if (!response.body) {
    complete();

    return response;
  }

  const reader = response.body.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();

        if (next.done) {
          controller.close();
          complete();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
        complete(true);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        complete();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    headers: response.headers,
    encodeBody: "manual",
  });
}
