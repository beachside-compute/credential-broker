import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { grantLabel, integrationId } from "../config";
import { newGrantToken, tokenHash, grantTokenPattern, bearer } from "../grants/tokens";
import { privateJson, privateNoContent, readJson } from "../http";
import type { Worker } from "../http";
import type { Tenant } from "../tenants/tenant";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import { failure } from "../proxy/forward";
import {
  alertEvent,
  deliver,
  destinationInput,
  mailer,
  newSigningSecret,
  sealDestination,
  testEvent,
  tripRequest,
} from "./alerts";
import type { CanarySummary, DestinationSummary, Trip } from "./types";

type AdminWorker = Worker & { Variables: { keyring: EncryptionKeyring } };

/** Canaries look like grants that run for the maximum lifetime. */
const displayedLifetimeMs = 7 * 24 * 60 * 60_000;

const canaryRequest = z.strictObject({
  integrations: z
    .array(integrationId)
    .min(1)
    .max(16)
    .refine((ids) => new Set(ids).size === ids.length),
  label: grantLabel.optional(),
  note: grantLabel.optional(),
});

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Send the alerts a trip claimed, without delaying the response or retrying. */
export function alertOnTrip<E extends Worker>(context: Context<E>, trip: Trip | undefined): void {
  if (!trip?.deliveries.length) return;

  const tenant: Tenant = context.get("tenant");
  const host = new URL(context.req.url).host;

  // A broken keyring must not change the caller's response, or a canary would stand out.
  const keyring = tenant.keyring().catch(() => undefined);

  context.executionCtx.waitUntil(
    keyring.then(async (keys) => {
      if (!keys) return;

      await Promise.all(
        trip.deliveries.map(async (delivery) => {
          const status = await deliver(
            delivery,
            alertEvent(trip, delivery, host),
            keys,
            mailer(context.env),
          );

          await tenant.store.recordDelivery(delivery.identity, status).catch(() => {});
        }),
      );
    }),
  );
}

/** Trip a canary presented as a role key. Real role keys never look like grant tokens. */
export async function tripRoleKey<E extends Worker>(
  context: Context<E>,
  route: string,
): Promise<void> {
  const token = bearer(context.req.header("authorization") ?? null);

  if (!token || !grantTokenPattern.test(token)) return;

  const trip = await context
    .get("tenant")
    .store.tripCanary(
      { hash: await tokenHash(token) },
      tripRequest(context.req.raw, route, "", token),
    );

  alertOnTrip(context, trip);
}

export const canaryAdminRoutes = new Hono<AdminWorker>();

canaryAdminRoutes.post("/canaries", async (context) => {
  const input = canaryRequest.safeParse(await readJson(context.req.raw, 4_096));

  if (!input.success) return failure(400, "invalid_canary_request");

  const token = newGrantToken();
  const id = crypto.randomUUID();
  const { integrations, label, note } = input.data;

  const result = await context.get("tenant").store.createCanary({
    id,
    hash: await tokenHash(token),
    integrations,
    label,
    note,
  });

  if (result.status === "not_found")
    return failure(404, "integration_not_found", false, {
      reason: "not_found",
      integrations: result.integrations,
    });

  if (result.status === "limit") return failure(429, "canary_limit");

  return privateJson(
    {
      id,
      token,
      expiresAt: new Date(Date.now() + displayedLifetimeMs).toISOString(),
      integrations,
      kinds: result.kinds,
    },
    201,
  );
});

canaryAdminRoutes.get("/canaries", async (context) =>
  privateJson({ canaries: (await context.get("tenant").store.listCanaries()).map(canaryView) }),
);

canaryAdminRoutes.get("/canaries/:id", async (context) => {
  const id = context.req.param("id");

  if (!uuid.test(id)) return failure(400, "invalid_canary_id");

  const canary = await context.get("tenant").store.getCanary(id);

  return canary
    ? privateJson({ ...canaryView(canary), events: canary.events })
    : failure(404, "canary_not_found");
});

canaryAdminRoutes.delete("/canaries/:id", async (context) => {
  const id = context.req.param("id");

  if (!uuid.test(id)) return failure(400, "invalid_canary_id");

  return (await context.get("tenant").store.revokeCanary(id))
    ? privateNoContent()
    : failure(404, "canary_not_found");
});

canaryAdminRoutes.get("/alerts", async (context) => {
  // Clients before email support reject unknown kinds, so they get only the kinds they parse.
  const email = context.req.query("include") === "email";
  const destinations = await context.get("tenant").store.listDestinations();

  return privateJson({
    destinations: destinations
      .filter((destination) => email || destination.kind !== "email")
      .map(destinationView),
  });
});

canaryAdminRoutes.post("/alerts", async (context) => {
  const input = destinationInput.safeParse(await readJson(context.req.raw, 64_000));

  if (!input.success) return failure(400, "invalid_alert_destination");

  const destination = input.data;

  if (destination.kind === "email" && !mailer(context.env))
    return failure(400, "email_alerts_not_configured");

  const { id, kind } = destination;
  const identity = crypto.randomUUID();
  const signingSecret = kind === "webhook" ? newSigningSecret() : undefined;
  const headers = destination.kind === "email" ? {} : (destination.headers ?? {});

  const config = await sealDestination(
    { identity, id, kind },
    destination.kind === "email"
      ? { to: destination.to }
      : { url: destination.url.href, headers, ...(signingSecret && { signingSecret }) },
    context.get("keyring"),
  );

  if (!config) return failure(400, "invalid_alert_destination");

  const result = await context.get("tenant").store.createDestination({
    identity,
    id,
    kind,
    config,
    host: destination.kind === "email" ? destination.to : destination.url.host,
    headerNames: Object.keys(headers),
  });

  if (result === "exists") return failure(409, "alert_destination_exists");

  if (result === "limit") return failure(429, "alert_destination_limit");

  return privateJson({ ...destinationView(result), ...(signingSecret && { signingSecret }) }, 201);
});

canaryAdminRoutes.post("/alerts/:id/test", async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));

  if (!id.success) return failure(400, "invalid_alert_destination_id");

  const store = context.get("tenant").store;
  const destination = await store.destination(id.data);

  if (!destination) return failure(404, "alert_destination_not_found");

  const status = await deliver(
    destination,
    testEvent(new URL(context.req.url).host),
    context.get("keyring"),
    mailer(context.env),
  );

  await store.recordDelivery(destination.identity, status);

  // An accepted email can still bounce later, so it is not reported as delivered.
  return destination.kind === "email"
    ? privateJson({ id: destination.id, kind: "email", status, accepted: status === 202 })
    : privateJson({ id: destination.id, status, delivered: status >= 200 && status < 300 });
});

canaryAdminRoutes.delete("/alerts/:id", async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));

  if (!id.success) return failure(400, "invalid_alert_destination_id");

  await context.get("tenant").store.deleteDestination(id.data);

  return privateNoContent();
});

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

function canaryView(canary: CanarySummary) {
  return {
    ...canary,
    createdAt: new Date(canary.createdAt).toISOString(),
    firstTrippedAt: iso(canary.firstTrippedAt),
    lastTrippedAt: iso(canary.lastTrippedAt),
  };
}

function destinationView(destination: DestinationSummary) {
  return {
    ...destination,
    createdAt: new Date(destination.createdAt).toISOString(),
    lastAlertAt: iso(destination.lastAlertAt),
    lastDeliveryAt: iso(destination.lastDeliveryAt),
  };
}
