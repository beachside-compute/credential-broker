import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { integrations } from "../integrations/schema";
import { alertDestinations, canaries, canaryEvents } from "../canaries/schema";
import { alertIntervalMs, maxCanaries, maxCanaryEvents, maxDestinations } from "../canaries/types";
import type {
  AlertDelivery,
  CanarySummary,
  DestinationSummary,
  Trip,
  TripRequest,
} from "../canaries/types";
import type {
  CanaryMatch,
  CanaryRecord,
  CanaryIssuance,
  DestinationRecord,
  RegistryStore,
} from "./shared";
import { destinationSummary } from "./shared";
import { alertKeyState, assertCurrentEncryptionKey, assertProvisioned } from "./tenant-keys";

/** Record a canary's use and claim the alerts that are due. Returns nothing for other tokens. */
export function tripCanary(
  store: RegistryStore,
  match: CanaryMatch,
  request: TripRequest,
): Trip | undefined {
  return store.ctx.storage.transactionSync(() => {
    const now = Date.now();

    const canary = store.db
      .update(canaries)
      .set({
        trips: sql`${canaries.trips} + 1`,
        firstTrippedAt: sql`coalesce(${canaries.firstTrippedAt}, ${now})`,
        lastTrippedAt: now,
      })
      .where("hash" in match ? eq(canaries.hash, match.hash) : eq(canaries.id, match.id))
      .returning()
      .get();

    if (!canary) return;

    const recorded = { ...request };
    store.db.insert(canaryEvents).values({ canaryId: canary.id, event: recorded, at: now }).run();
    store.db.run(sql`
      DELETE FROM ${canaryEvents} WHERE ${canaryEvents.canaryId} = ${canary.id} AND ${canaryEvents.id} NOT IN (
        SELECT ${canaryEvents.id} FROM ${canaryEvents} WHERE ${canaryEvents.canaryId} = ${canary.id}
        ORDER BY ${canaryEvents.id} DESC LIMIT ${maxCanaryEvents}
      )
    `);

    const label = canary.label ?? canary.id;
    const deliveries: AlertDelivery[] = [];

    for (const destination of store.db.select().from(alertDestinations).all()) {
      const labels = [...new Set([...destination.pendingLabels, label])].slice(-20);

      const due =
        destination.lastAlertAt === null || now - destination.lastAlertAt >= alertIntervalMs;

      store.db
        .update(alertDestinations)
        .set(
          due
            ? { lastAlertAt: now, pendingTrips: 0, pendingLabels: [] }
            : { pendingTrips: destination.pendingTrips + 1, pendingLabels: labels },
        )
        .where(eq(alertDestinations.identity, destination.identity))
        .run();

      if (due)
        deliveries.push({
          identity: destination.identity,
          id: destination.id,
          kind: destination.kind,
          config: destination.config,
          trips: destination.pendingTrips + 1,
          labels,
        });
    }

    return {
      event: {
        canary_id: canary.id,
        canary_label: label,
        canary_note: canary.note ?? "",
        canary_created_at: new Date(canary.createdAt).toISOString(),
        occurred_at: new Date(now).toISOString(),
        trips_total: String(canary.trips),
        first_tripped_at: new Date(canary.firstTrippedAt ?? now).toISOString(),
        ...Object.fromEntries(
          Object.entries(request).map(([key, value]) => [`request_${key}`, value]),
        ),
      },
      deliveries,
      keyState: deliveries.length ? alertKeyState(store) : null,
    };
  });
}

export function createCanary(store: RegistryStore, record: CanaryRecord): CanaryIssuance {
  return store.ctx.storage.transactionSync((): CanaryIssuance => {
    const known = store.db
      .select({ id: integrations.id, kind: integrations.kind })
      .from(integrations)
      .where(inArray(integrations.id, record.integrations))
      .all();

    const missing = record.integrations.filter((id) => !known.some((row) => row.id === id));

    if (missing.length) return { status: "not_found", integrations: missing };

    const { total } = store.db.select({ total: count() }).from(canaries).get()!;

    if (total >= maxCanaries) return { status: "limit" };

    store.db
      .insert(canaries)
      .values({
        id: record.id,
        hash: record.hash,
        label: record.label,
        note: record.note,
        integrations: record.integrations,
        createdAt: Date.now(),
      })
      .run();

    return {
      status: "created",
      kinds: Object.fromEntries(known.map(({ id, kind }) => [id, kind])),
    };
  });
}

export function listCanaries(store: RegistryStore): CanarySummary[] {
  return store.db
    .select({
      id: canaries.id,
      label: canaries.label,
      note: canaries.note,
      integrations: canaries.integrations,
      createdAt: canaries.createdAt,
      trips: canaries.trips,
      firstTrippedAt: canaries.firstTrippedAt,
      lastTrippedAt: canaries.lastTrippedAt,
    })
    .from(canaries)
    .orderBy(desc(canaries.createdAt), canaries.id)
    .all();
}

/** A canary with its most recent trips, newest first. */
export function getCanary(
  store: RegistryStore,
  id: string,
): (CanarySummary & { events: Record<string, string>[] }) | undefined {
  const canary = listCanaries(store).find((row) => row.id === id);

  if (!canary) return;

  const events = store.db
    .select({ event: canaryEvents.event, at: canaryEvents.at })
    .from(canaryEvents)
    .where(eq(canaryEvents.canaryId, id))
    .orderBy(desc(canaryEvents.id))
    .all()
    .map(({ event, at }) => ({ at: new Date(at).toISOString(), ...event }));

  return { ...canary, events };
}

export function revokeCanary(store: RegistryStore, id: string): boolean {
  return Boolean(
    store.db.delete(canaries).where(eq(canaries.id, id)).returning({ id: canaries.id }).get(),
  );
}

export function createDestination(
  store: RegistryStore,
  record: DestinationRecord,
): "exists" | "limit" | DestinationSummary {
  assertProvisioned(store);
  assertCurrentEncryptionKey(store, record.config);

  return store.ctx.storage.transactionSync(() => {
    const existing = store.db
      .select({ id: alertDestinations.id })
      .from(alertDestinations)
      .where(eq(alertDestinations.id, record.id))
      .get();

    if (existing) return "exists";

    const { total } = store.db.select({ total: count() }).from(alertDestinations).get()!;

    if (total >= maxDestinations) return "limit";

    const created = store.db
      .insert(alertDestinations)
      .values({ ...record, createdAt: Date.now() })
      .returning()
      .get();

    return destinationSummary(created);
  });
}

export function listDestinations(store: RegistryStore): DestinationSummary[] {
  return store.db
    .select()
    .from(alertDestinations)
    .orderBy(alertDestinations.id)
    .all()
    .map(destinationSummary);
}

/** A destination's sealed configuration, for a test delivery. */
export function destination(store: RegistryStore, id: string) {
  const destination = store.db
    .select({
      identity: alertDestinations.identity,
      id: alertDestinations.id,
      kind: alertDestinations.kind,
      config: alertDestinations.config,
    })
    .from(alertDestinations)
    .where(eq(alertDestinations.id, id))
    .get();

  return destination && { ...destination, keyState: alertKeyState(store) };
}

export function deleteDestination(store: RegistryStore, id: string): void {
  store.db.delete(alertDestinations).where(eq(alertDestinations.id, id)).run();
}

export function recordDelivery(store: RegistryStore, identity: string, status: number): void {
  store.db
    .update(alertDestinations)
    .set({ lastDeliveryAt: Date.now(), lastStatus: status })
    .where(eq(alertDestinations.identity, identity))
    .run();
}
