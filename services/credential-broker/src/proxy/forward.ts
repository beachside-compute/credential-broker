import type { ResolvedCredential } from "../credentials/source";
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

export function failure(status: number, error: string, challenge = false): Response {
  const headers = new Headers({ "cache-control": "no-store" });

  if (challenge) headers.set("www-authenticate", 'Basic realm="Beachside Git"');

  return Response.json({ error }, { status, headers });
}

export async function upstream(
  request: Request,
  target: Route,
  credential: ResolvedCredential,
): Promise<Response> {
  const headers = copyHeaders(request.headers, clientHeaders);
  headers.set("user-agent", "Beachside-Credential-Broker/0.0.0");
  headers.set("accept-encoding", "identity");

  if (target.type === "git") {
    headers.set("authorization", `Basic ${btoa(`x-access-token:${credential.value}`)}`);
  } else if (target.integration.kind === "anthropic") {
    headers.set("x-api-key", credential.value);

    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("authorization", `Bearer ${credential.value}`);
  }

  // No retries. In particular, a transport error says nothing about whether a write landed.
  const response = await fetch(target.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    signal: request.signal,
  });

  const responseHeaders = copyHeaders(response.headers, upstreamHeaders);
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
