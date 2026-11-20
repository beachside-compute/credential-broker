import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span, SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, ParentBasedSampler, TracerProvider } from "@opentelemetry/sdk-trace";
import { exportSpan, traceAuthorization, traceEndpoint } from "./otlp";
import type { TraceExportBindings } from "./otlp";

const scope = "beachside.credential-broker";

const resource = resourceFromAttributes({ "service.name": scope });

const sampler = new ParentBasedSampler({ root: new AlwaysOnSampler() });

const traceparentPattern = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;

export function parseTraceparent(value: string | null): SpanContext | undefined {
  const parts = value?.match(traceparentPattern);

  if (!parts || /^0+$/.test(parts[1]) || /^0+$/.test(parts[2])) return;

  return {
    traceId: parts[1],
    spanId: parts[2],
    traceFlags: Number.parseInt(parts[3], 16) & 1,
    isRemote: true,
  };
}

export type AdminOperation =
  | "admin.integration.list"
  | "admin.integration.create"
  | "admin.integration.read"
  | "admin.integration.update"
  | "admin.integration.rotate"
  | "admin.integration.delete"
  | "admin.issuer_permissions.read"
  | "admin.issuer_permissions.update";

type Operation = "grant.create" | "grant.revoke" | "gateway" | AdminOperation;

export function startSpan(
  env: TraceExportBindings,
  waitUntil: (work: Promise<void>) => void,
  operation: Operation,
  parent?: SpanContext,
  origin?: SpanContext,
): Span | undefined {
  try {
    if (env.BROKER_OTLP_TRACES_ENDPOINT === undefined) return;
    const endpoint = traceEndpoint(env.BROKER_OTLP_TRACES_ENDPOINT);

    const authorization =
      env.BROKER_OTLP_AUTHORIZATION === undefined
        ? undefined
        : traceAuthorization(env.BROKER_OTLP_AUTHORIZATION);

    // The processor exports this request's span directly. It owns no queue or isolate-wide I/O.
    const provider = new TracerProvider({
      resource,
      sampler,
      spanProcessors: [
        {
          onStart() {},
          onEnd(span) {
            waitUntil(exportSpan(endpoint, authorization, span));
          },
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    });

    return provider
      .getTracer(scope, "0.0.0")
      .startSpan(
        `beachside.broker.${operation}`,
        { kind: SpanKind.SERVER, links: origin ? [{ context: origin }] : [] },
        parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
      );
  } catch {
    return;
  }
}

export function grantOrigin(
  span: Span | undefined,
  parent: SpanContext | undefined,
): string | undefined {
  let context = parent;

  try {
    const local = span?.spanContext();

    if (local && trace.isSpanContextValid(local)) context = local;
  } catch {
    // An unusable tracer cannot affect issuance.
  }

  if (!context) return;

  return `00-${context.traceId}-${context.spanId}-${context.traceFlags & 1 ? "01" : "00"}`;
}

export function finishSpan(span: Span | undefined, status: number, failed = false): void {
  try {
    span?.setAttribute("http.response.status_code", status);

    if (failed || status >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
    // Telemetry is best effort.
  } finally {
    try {
      span?.end();
    } catch {
      // Telemetry is best effort.
    }
  }
}
