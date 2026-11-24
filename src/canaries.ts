/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Parse canary and alert replies at the HTTP trust boundary. */
import { CredentialBrokerError, integrationName } from "./transport.js";

export type BrokerAlertKind = "slack" | "webhook" | "email";

/** Where the broker sends canary alerts. URLs and header values stay sealed; `host` is an email destination's address. */
export interface BrokerAlertDestination {
  readonly id: string;
  readonly kind: BrokerAlertKind;
  readonly host: string;
  readonly headerNames: readonly string[];
  readonly createdAt: string;
  readonly lastAlertAt: string | null;
  readonly lastDeliveryAt: string | null;
  /** HTTP status of the last delivery; 0 when nothing answered. */
  readonly lastStatus: number | null;
}

export type BrokerAlertDestinationInput =
  | {
      id: string;
      kind: "slack" | "webhook";
      url: string;
      headers?: Readonly<Record<string, string>>;
    }
  | { id: string; kind: "email"; to: string };

export interface BrokerCanary {
  readonly id: string;
  readonly label: string | null;
  readonly note: string | null;
  readonly integrations: readonly string[];
  readonly createdAt: string;
  readonly trips: number;
  readonly firstTrippedAt: string | null;
  readonly lastTrippedAt: string | null;
}

/** One recorded use of a canary: when, which route, and what Cloudflare saw of the caller. */
export type BrokerCanaryEvent = Readonly<Record<string, string>>;

/** A newly issued canary. It has the shape of a grant so it plants like one. */
export interface BrokerCanaryToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly integrations: readonly string[];
  readonly kinds: Readonly<Record<string, CanaryIntegrationKind>>;
}

type CanaryIntegrationKind = "github" | "anthropic" | "openai" | "openrouter" | "http";

const kindNames: readonly CanaryIntegrationKind[] = [
  "github",
  "anthropic",
  "openai",
  "openrouter",
  "http",
];

function kindName(value: unknown): CanaryIntegrationKind {
  return kindNames.find((kind) => kind === value) ?? invalid();
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const token = /^bsg_[a-f0-9]{64}$/;

function invalid(): never {
  throw new CredentialBrokerError(
    "INVALID_RESPONSE",
    "Credential broker returned an invalid canary",
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();

  return Object.fromEntries(Object.entries(value));
}

function time(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : invalid();
}

function optionalTime(value: unknown): string | null {
  return value === null ? null : time(value);
}

function optionalText(value: unknown): string | null {
  return value === null || typeof value === "string" ? value : invalid();
}

function names(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((id) => typeof id === "string" && integrationName.test(id))
    ? [...value]
    : invalid();
}

export function canaryId(id: string): string {
  if (typeof id !== "string" || !uuid.test(id))
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      "Canary IDs are UUIDs, as `canary list` shows them",
    );

  return id;
}

export function parseCanary(value: unknown): BrokerCanary {
  const reply = record(value);

  if (typeof reply.id !== "string" || !uuid.test(reply.id)) invalid();

  if (typeof reply.trips !== "number" || !Number.isSafeInteger(reply.trips)) invalid();

  return {
    id: reply.id,
    label: optionalText(reply.label),
    note: optionalText(reply.note),
    integrations: names(reply.integrations),
    createdAt: time(reply.createdAt),
    trips: reply.trips,
    firstTrippedAt: optionalTime(reply.firstTrippedAt),
    lastTrippedAt: optionalTime(reply.lastTrippedAt),
  };
}

export function parseCanaryEvents(value: unknown): BrokerCanaryEvent[] {
  if (!Array.isArray(value)) invalid();

  return value.map((event) => {
    const fields = Object.entries(record(event));

    return fields.every(([, field]) => typeof field === "string")
      ? Object.fromEntries(fields.map(([name, field]) => [name, String(field)]))
      : invalid();
  });
}

export function parseCanaryToken(value: unknown): BrokerCanaryToken {
  const reply = record(value);
  const kinds = record(reply.kinds);

  if (
    typeof reply.id !== "string" ||
    !uuid.test(reply.id) ||
    typeof reply.token !== "string" ||
    !token.test(reply.token)
  )
    invalid();

  return {
    id: reply.id,
    token: reply.token,
    expiresAt: time(reply.expiresAt),
    integrations: names(reply.integrations),
    kinds: Object.fromEntries(Object.entries(kinds).map(([id, kind]) => [id, kindName(kind)])),
  };
}

export function parseDestination(value: unknown): BrokerAlertDestination {
  const reply = record(value);
  const { id, kind, host, lastStatus } = reply;

  if (
    typeof id !== "string" ||
    !integrationName.test(id) ||
    (kind !== "slack" && kind !== "webhook" && kind !== "email") ||
    typeof host !== "string" ||
    !Array.isArray(reply.headerNames) ||
    !reply.headerNames.every((name) => typeof name === "string") ||
    (lastStatus !== null && typeof lastStatus !== "number")
  )
    invalid();

  return {
    id,
    kind,
    host,
    headerNames: reply.headerNames.map(String),
    createdAt: time(reply.createdAt),
    lastAlertAt: optionalTime(reply.lastAlertAt),
    lastDeliveryAt: optionalTime(reply.lastDeliveryAt),
    lastStatus,
  };
}

export function destinationInput(input: BrokerAlertDestinationInput): BrokerAlertDestinationInput {
  if (typeof input?.id !== "string" || !integrationName.test(input.id)) return invalidDestination();

  if (input.kind === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to ?? "")
      ? { id: input.id, kind: "email", to: input.to }
      : invalidDestination();

  const url = URL.parse(input?.url ?? "");

  if (
    (input.kind !== "slack" && input.kind !== "webhook") ||
    url?.protocol !== "https:" ||
    (input.kind === "slack" && (url.hostname !== "hooks.slack.com" || input.headers))
  )
    return invalidDestination();

  return {
    id: input.id,
    kind: input.kind,
    url: url.href,
    ...(input.headers && { headers: { ...input.headers } }),
  };
}

function invalidDestination(): never {
  throw new CredentialBrokerError(
    "INVALID_ARGUMENT",
    "Alert destinations need an HTTPS URL or, for email, one address; Slack takes an incoming webhook URL on hooks.slack.com and no headers",
  );
}
