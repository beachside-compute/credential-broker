import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

export interface TraceExportBindings {
  BROKER_OTLP_TRACES_ENDPOINT?: string;
  BROKER_OTLP_AUTHORIZATION?: string;
}

export function traceEndpoint(value: string): string {
  const url = new URL(value);

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "BROKER_OTLP_TRACES_ENDPOINT must be an HTTPS URL without credentials, query, or fragment",
    );
  }

  return url.href;
}

export function traceAuthorization(value: string): string {
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value)) {
    throw new Error("BROKER_OTLP_AUTHORIZATION must be a non-empty printable Authorization header");
  }

  return value;
}

export async function exportSpan(
  endpoint: string,
  authorization: string | undefined,
  span: ReadableSpan,
) {
  try {
    const headers = new Headers({ "content-type": "application/json" });

    if (authorization !== undefined) headers.set("authorization", authorization);

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JsonTraceSerializer.serializeRequest([span]),
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    });

    await response.body?.cancel();
  } catch {
    // A collector failure cannot change request results or trigger another export.
  }
}
