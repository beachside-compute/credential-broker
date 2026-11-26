import { and, count, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import type { Principal } from "../auth";
import { brokerIntegration } from "../integrations/definitions";
import { integrations, issuerIntegrations } from "../integrations/schema";
import { grants } from "../grants/schema";
import type { Trip, TripRequest } from "../canaries/types";
import type {
  GrantRecord,
  IssuanceRefusal,
  Issuance,
  GrantSummary,
  Renewal,
  RegistryStore,
} from "./shared";
import { maxActiveGrants, maxActiveGrantsPerOwner, summary } from "./shared";
import { tripCanary } from "./canaries";

export async function create(
  store: RegistryStore,
  record: GrantRecord,
  principal: Principal,
): Promise<Issuance> {
  const now = Date.now();

  const result = store.ctx.storage.transactionSync((): Issuance => {
    const outsidePolicy = principal.integrations
      ? record.integrations.filter((id) => !principal.integrations!.includes(id))
      : [];

    if (outsidePolicy.length)
      return { status: "forbidden", reason: "not_in_policy", integrations: outsidePolicy };

    const known = store.db
      .select({
        id: integrations.id,
        identity: integrations.identity,
        kind: integrations.kind,
        enabled: integrations.enabled,
        allowed: issuerIntegrations.identity,
      })
      .from(integrations)
      .leftJoin(issuerIntegrations, eq(issuerIntegrations.identity, integrations.identity))
      .where(inArray(integrations.id, record.integrations))
      .all();

    const refused = (reason: IssuanceRefusal, ids: string[]): Issuance | undefined =>
      ids.length ? { status: "forbidden", reason, integrations: ids } : undefined;

    const refusal =
      refused(
        "not_found",
        record.integrations.filter((id) => !known.some((row) => row.id === id)),
      ) ??
      refused(
        "disabled",
        known.filter(({ enabled }) => !enabled).map(({ id }) => id),
      ) ??
      refused(
        "not_allowlisted",
        known.filter(({ allowed }) => allowed === null).map(({ id }) => id),
      );

    if (refusal) return refusal;

    if (known.filter(({ kind }) => brokerIntegration(kind).family === "github").length > 1)
      return { status: "ambiguous_github" };

    // Bound all active rows, including simultaneous issuances from several workflow runs.
    const { total } = store.db
      .select({ total: count() })
      .from(grants)
      .where(gt(grants.expiresAt, now))
      .get()!;

    const { owned } = store.db
      .select({ owned: count() })
      .from(grants)
      .where(and(eq(grants.owner, record.owner), gt(grants.expiresAt, now)))
      .get()!;

    if (total >= maxActiveGrants || owned >= maxActiveGrantsPerOwner) return { status: "limit" };

    const { id, hash, owner, expiresAt, traceparent, label } = record;
    store.db
      .insert(grants)
      .values({
        id,
        hash,
        owner,
        expiresAt,
        traceparent,
        label,
        createdAt: now,
        permissions: known.map(({ identity }) => identity),
      })
      .run();

    return {
      status: "created",
      kinds: Object.fromEntries(known.map(({ id: name, kind }) => [name, kind])),
    };
  });

  if (result.status === "created") await scheduleCleanup(store, record.expiresAt);

  return result;
}

/** Active grants, newest first. Pass a principal to limit results to the issuer and its policy. */
export function listGrants(store: RegistryStore, principal?: Principal): GrantSummary[] {
  const now = Date.now();

  const names = new Map(
    store.db
      .select({ identity: integrations.identity, id: integrations.id })
      .from(integrations)
      .all()
      .map(({ identity, id }) => [identity, id]),
  );

  return store.db
    .select()
    .from(grants)
    .where(and(gt(grants.expiresAt, now), principal && grantScope(store, principal)))
    .orderBy(desc(grants.createdAt), grants.id)
    .all()
    .map((grant) => summary(grant, names));
}

/** Move an active grant's expiry to `expiresAt`, keeping its scope and token. */
export async function renew(
  store: RegistryStore,
  id: string,
  principal: Principal,
  expiresAt: number,
  request: TripRequest,
): Promise<Renewal> {
  const now = Date.now();

  const renewed = store.db
    .update(grants)
    .set({ expiresAt })
    .where(and(eq(grants.id, id), grantScope(store, principal), gt(grants.expiresAt, now)))
    .returning()
    .get();

  if (!renewed) return { status: "not_found", trip: tripCanary(store, { id }, request) };

  await scheduleCleanup(store, expiresAt);

  const names = new Map(
    store.db
      .select({ identity: integrations.identity, id: integrations.id })
      .from(integrations)
      .where(inArray(integrations.identity, renewed.permissions))
      .all()
      .map(({ identity, id: name }) => [identity, name]),
  );

  return { status: "renewed", grant: summary(renewed, names) };
}

/** Counts for the admin status view. */
export function counts(store: RegistryStore) {
  const now = Date.now();
  const { total } = store.db.select({ total: count() }).from(integrations).get()!;

  // Issuable means the issuer can mint a grant for it now: allowlisted and enabled.
  const { issuable } = store.db
    .select({ issuable: count() })
    .from(issuerIntegrations)
    .innerJoin(integrations, eq(issuerIntegrations.identity, integrations.identity))
    .where(eq(integrations.enabled, true))
    .get()!;

  const { active } = store.db
    .select({ active: count() })
    .from(grants)
    .where(gt(grants.expiresAt, now))
    .get()!;

  return { integrations: total, issuable, activeGrants: active };
}

/** Revoke a grant. Naming a canary instead trips it. */
export function revoke(
  store: RegistryStore,
  id: string,
  principal: Principal,
  request: TripRequest,
): Trip | undefined {
  const revoked = store.db
    .delete(grants)
    .where(and(eq(grants.id, id), grantScope(store, principal)))
    .returning({ id: grants.id })
    .get();

  return revoked ? undefined : tripCanary(store, { id }, request);
}

export function grantScope(store: RegistryStore, principal: Principal) {
  const owner = eq(grants.owner, principal.owner);

  if (principal.integrations === undefined) return owner;

  const allowed = store.db
    .select({ identity: integrations.identity })
    .from(integrations)
    .where(inArray(integrations.id, principal.integrations));

  const outsidePolicy = notInArray(sql`value`, allowed);

  return and(
    owner,
    sql`NOT EXISTS (SELECT 1 FROM json_each(${grants.permissions}) WHERE ${outsidePolicy})`,
  );
}

export async function scheduleCleanup(store: RegistryStore, at: number): Promise<void> {
  const current = await store.ctx.storage.getAlarm();

  if (current == null || at < current) await store.ctx.storage.setAlarm(at);
}
