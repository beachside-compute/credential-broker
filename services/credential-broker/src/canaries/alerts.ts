import { z } from "zod";
import { openValue, sealValue } from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { EncryptedCredential } from "../credentials/source";
import type { AlertKind } from "./schema";
import type { AlertDelivery, AlertEvent, Trip, TripRequest } from "./types";

const encoder = new TextEncoder();

const reservedHeaders = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
  "user-agent",
  "webhook-id",
  "webhook-signature",
  "webhook-timestamp",
]);

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/)
  .refine((name) => !reservedHeaders.has(name.toLowerCase()));

const headerValue = z.string().regex(/^[\x20-\x7e]{1,4096}$/);

const destinationUrl = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    const url = URL.parse(value);

    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      /^[0-9.]+$|^\[/.test(url.hostname)
    ) {
      ctx.addIssue({ code: "custom", message: "invalid destination URL" });

      return z.NEVER;
    }

    return url;
  });

const destinationId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const urlDestination = z
  .strictObject({
    id: destinationId,
    kind: z.enum(["slack", "webhook"]),
    url: destinationUrl,
    headers: z
      .record(headerName, headerValue)
      .refine((headers) => Object.keys(headers).length <= 10)
      .optional(),
  })
  .refine(
    ({ kind, url, headers }) =>
      kind === "webhook" || (url.hostname === "hooks.slack.com" && !headers),
  );

const emailDestination = z.strictObject({
  id: destinationId,
  kind: z.literal("email"),
  to: z.email().max(254),
});

export const destinationInput = z.union([urlDestination, emailDestination]);

/** The sealed configuration's plaintext limit, enforced when it is created and opened. */
export const maxDestinationConfigBytes = 16_384;

type DestinationConfig =
  | { url: string; headers: Record<string, string>; signingSecret?: string }
  | { to: string };

/** Email alerts go through the deployment's send_email binding from its configured sender. */
export interface Mailer {
  binding: SendEmail;
  from: string;
}

export function mailer(env: { EMAIL?: SendEmail; BROKER_EMAIL_FROM?: string }): Mailer | undefined {
  return env.EMAIL && env.BROKER_EMAIL_FROM
    ? { binding: env.EMAIL, from: env.BROKER_EMAIL_FROM }
    : undefined;
}

function sealContext(destination: { identity: string; id: string; kind: AlertKind }) {
  return ["beachside-alert/v1", destination.identity, destination.id, destination.kind];
}

/** Seal a destination, or return nothing when delivery could not open it again. */
export async function sealDestination(
  destination: { identity: string; id: string; kind: AlertKind },
  config: DestinationConfig,
  keyring: EncryptionKeyring,
): Promise<EncryptedCredential | undefined> {
  const json = JSON.stringify(config);

  if (encoder.encode(json).byteLength > maxDestinationConfigBytes) return;

  return sealValue(json, sealContext(destination), keyring);
}

/** A Standard Webhooks signing secret. */
export function newSigningSecret(): string {
  return `whsec_${base64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function tripRequest(
  request: Request,
  route: string,
  integration = "",
  token?: string,
): TripRequest {
  const cf = request.cf;
  const path = new URL(request.url).pathname;

  return {
    route,
    integration,
    method: request.method,
    path: (token ? path.replaceAll(token, "[canary]") : path).slice(0, 512),
    ip: request.headers.get("cf-connecting-ip") ?? "",
    country: String(cf?.country ?? ""),
    asn: String(cf?.asn ?? ""),
    as_org: String(cf?.asOrganization ?? ""),
    colo: String(cf?.colo ?? ""),
    user_agent: (request.headers.get("user-agent") ?? "").slice(0, 256),
  };
}

export function alertEvent(
  trip: Trip,
  delivery: Pick<AlertDelivery, "trips" | "labels">,
  host: string,
): AlertEvent {
  const { event } = trip;
  const where = [event.request_as_org, event.request_country].filter(Boolean).join(", ");

  return {
    type: "canary.triggered",
    event_id: `evt_${crypto.randomUUID()}`,
    dedup_key: `beachside-canary-${event.canary_id}`,
    status: "firing",
    severity: "critical",
    title: `Canary "${event.canary_label}" used from ${event.request_ip || "an unknown address"}${where ? ` (${where})` : ""} via ${event.request_route}`,
    broker_host: host,
    ...event,
    trips_since_last_alert: String(delivery.trips),
    canaries_tripped: delivery.labels.join(", "),
  };
}

export function testEvent(host: string): AlertEvent {
  return {
    type: "canary.test",
    event_id: `evt_${crypto.randomUUID()}`,
    dedup_key: "beachside-canary-test",
    status: "firing",
    severity: "info",
    title: "Test alert from the Beachside credential broker",
    broker_host: host,
    occurred_at: new Date().toISOString(),
  };
}

/** Send one alert. Returns the HTTP status (202 for accepted email), or 0 on failure. Never retries. */
export async function deliver(
  destination: Pick<AlertDelivery, "identity" | "id" | "kind" | "config">,
  event: AlertEvent,
  keyring: EncryptionKeyring,
  mail?: Mailer,
): Promise<number> {
  try {
    const json = await openValue(
      destination.config,
      sealContext(destination),
      keyring,
      maxDestinationConfigBytes,
    );

    if (json === undefined) return 0;

    const config: DestinationConfig = JSON.parse(json);

    if ("to" in config) {
      if (!mail) return 0;

      await mail.binding.send({
        to: config.to,
        from: { email: mail.from, name: "Beachside credential broker" },
        subject: event.title!.slice(0, 200),
        text: emailText(event),
      });

      return 202;
    }

    const body = JSON.stringify(destination.kind === "slack" ? slackMessage(event) : event);

    const headers = new Headers({
      ...config.headers,
      "content-type": "application/json",
      "user-agent": "Beachside-Credential-Broker/0.0.0",
    });

    if (config.signingSecret) {
      const timestamp = String(Math.floor(Date.now() / 1_000));
      headers.set("webhook-id", event.event_id);
      headers.set("webhook-timestamp", timestamp);
      headers.set(
        "webhook-signature",
        `v1,${await sign(config.signingSecret, `${event.event_id}.${timestamp}.${body}`)}`,
      );
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    await response.body?.cancel();

    return response.status;
  } catch {
    return 0;
  }
}

function slackMessage(event: AlertEvent) {
  const fields = [
    ["Canary", event.canary_label],
    ["Route", [event.request_route, event.request_integration].filter(Boolean).join(" ")],
    ["Request", [event.request_method, event.request_path].filter(Boolean).join(" ")],
    [
      "Network",
      [event.request_as_org, event.request_asn && `AS${event.request_asn}`, event.request_country]
        .filter(Boolean)
        .join(", "),
    ],
    ["User agent", event.request_user_agent],
    [
      "Trips",
      event.trips_total &&
        `${event.trips_total} total, ${event.trips_since_last_alert} since the last alert`,
    ],
    ["Also tripped", event.canaries_tripped !== event.canary_label ? event.canaries_tripped : ""],
  ].filter(([, value]) => value);

  return {
    text: event.title,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: clip(`*${escape(event.title)}*`, 3_000) } },
      ...(fields.length
        ? [
            {
              type: "section",
              fields: fields.map(([name, value]) => ({
                type: "mrkdwn",
                text: clip(`*${name}*\n${escape(value)}`, 2_000),
              })),
            },
          ]
        : []),
    ],
  };
}

function emailText(event: AlertEvent) {
  const lines = Object.entries(event)
    .filter(([name, value]) => value && name !== "title")
    .map(([name, value]) => `${name}: ${value}`);

  return [event.title, "", ...lines].join("\n");
}

/** Slack rejects a block over its limit, so cut long text and any entity the cut splits. */
function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/&[a-z]*$/, "")}…`;
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function sign(secret: string, content: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64(secret.slice("whsec_".length)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(content))));
}

function base64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < bytes.length; index++) bytes[index] = decoded.charCodeAt(index);

  return bytes;
}
