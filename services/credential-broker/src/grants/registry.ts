import { DurableObject } from "cloudflare:workers";
import { and, count, desc, eq, gt, inArray, lte, min, ne, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import type { Principal } from "../auth";
import { requestLimit } from "../config";
import type { RequestLimits, TenantConfig } from "../config";
import type { CredentialReference, EncryptedCredential } from "../credentials/source";
import { integrations, issuerIntegrations } from "../integrations/schema";
import { maxIntegrations } from "../integrations/types";
import type {
  IntegrationKind,
  IntegrationMetadata,
  IntegrationRevision,
  IntegrationSelector,
  StoredIntegration,
} from "../integrations/types";
import { grants, leases, usage } from "./schema";
import { alertDestinations, canaries, canaryEvents } from "../canaries/schema";
import { alertIntervalMs, maxCanaries, maxCanaryEvents, maxDestinations } from "../canaries/types";
import type {
  AlertDelivery,
  CanarySummary,
  DestinationSummary,
  Trip,
  TripRequest,
} from "../canaries/types";

import { dataKeys, roleKeys, tenant } from "../tenants/schema";
import type { TenantRole } from "../tenants/identity";

export interface TenantProvision {
  id: string;
  dataKey: EncryptedCredential;
  adminHash: string;
  issuerHash: string;
}

export const tenantDataKeyVersion = "t1";

const rotationBatchSize = 8;

const minuteMs = 60_000;

const maxActiveGrants = 1000;

const maxActiveGrantsPerOwner = 100;

/** A request renews its lease while it runs, so an expired lease means its release was lost. */
export const leaseTtlMs = 15 * minuteMs;

export interface GrantRecord {
  id: string;
  hash: string;
  owner: string;
  integrations: string[];
  expiresAt: number;
  label?: string;
  traceparent?: string;
}

/** Why issuance refused an integration, most actionable first. */
export type IssuanceRefusal = "not_in_policy" | "not_found" | "disabled" | "not_allowlisted";

type Issuance =
  | { status: "created"; kinds: Record<string, IntegrationKind> }
  | { status: "forbidden"; reason: IssuanceRefusal; integrations: string[] }
  | { status: "ambiguous_github" }
  | { status: "limit" };

export interface GrantSummary {
  id: string;
  owner: string;
  integrations: string[];
  label: string | null;
  createdAt: number;
  expiresAt: number;
  requests: number;
  lastUsedAt: number | null;
}

type Renewal = { status: "renewed"; grant: GrantSummary } | { status: "not_found"; trip?: Trip };

type CanaryMatch = { hash: string } | { id: string };

export interface CanaryRecord {
  id: string;
  hash: string;
  integrations: string[];
  label?: string;
  note?: string;
}

type CanaryIssuance =
  | { status: "created"; kinds: Record<string, IntegrationKind> }
  | { status: "not_found"; integrations: string[] }
  | { status: "limit" };

export interface DestinationRecord {
  identity: string;
  id: string;
  kind: AlertDelivery["kind"];
  config: AlertDelivery["config"];
  host: string;
  headerNames: string[];
}

type IntegrationCreation = "exists" | "limit" | IntegrationMetadata;

export type Authorization =
  | {
      status: "allowed";
      leaseId: string;
      traceparent: string | null;
      integration: StoredIntegration;
    }
  | { status: "invalid"; trip?: Trip }
  | { status: "forbidden" | "busy" };

export class GrantRegistry extends DurableObject {
  private readonly db;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  provision({ id, dataKey, adminHash, issuerHash }: TenantProvision): void {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.db.delete(tenant).run();
      this.db.delete(roleKeys).run();
      this.db.delete(dataKeys).run();
      this.db.insert(tenant).values({ id, createdAt: now }).run();
      this.db
        .insert(roleKeys)
        .values([
          { role: "admin", hash: adminHash, createdAt: now },
          { role: "issuer", hash: issuerHash, createdAt: now },
        ])
        .run();
      this.db
        .insert(dataKeys)
        .values({
          version: tenantDataKeyVersion,
          wrapped: dataKey,
          createdAt: now,
        })
        .run();
    });
  }

  role(hash: string): TenantRole | undefined {
    return this.db
      .select({ role: roleKeys.role })
      .from(roleKeys)
      .where(eq(roleKeys.hash, hash))
      .get()?.role;
  }

  hasRoleKey(role: TenantRole): boolean {
    return Boolean(
      this.db.select({ role: roleKeys.role }).from(roleKeys).where(eq(roleKeys.role, role)).get(),
    );
  }

  setRoleKey(role: TenantRole, hash: string): void {
    const values = { hash, createdAt: Date.now() };
    this.db
      .insert(roleKeys)
      .values({ role, ...values })
      .onConflictDoUpdate({
        target: roleKeys.role,
        set: values,
      })
      .run();
  }

  dataKeys() {
    return {
      active: this.activeDataKey() ?? tenantDataKeyVersion,
      keys: this.db.select().from(dataKeys).orderBy(dataKeys.version).all(),
    };
  }

  rewrapDataKeys(
    version: string,
    previous: EncryptedCredential,
    wrapped: EncryptedCredential,
  ): boolean {
    return Boolean(
      this.db
        .update(dataKeys)
        .set({ wrapped })
        .where(and(eq(dataKeys.version, version), envelopeMatches(dataKeys.wrapped, previous)))
        .returning({ version: dataKeys.version })
        .get(),
    );
  }

  beginDataKeyRotation(expected: string, version: string, wrapped: EncryptedCredential): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (
        this.activeDataKey() !== expected ||
        this.db.select({ total: count() }).from(dataKeys).get()!.total !== 1
      )
        return false;

      this.db.insert(dataKeys).values({ version, wrapped, createdAt: Date.now() }).run();
      this.db.update(tenant).set({ activeDataKey: version }).run();

      return true;
    });
  }

  dataKeyRotationBatch(active: string) {
    if (this.activeDataKey() !== active) return;

    const credentials = this.db
      .select()
      .from(integrations)
      .where(needsRotation(integrations.credential, active))
      .limit(rotationBatchSize)
      .all();

    const destinations = this.db
      .select({
        identity: alertDestinations.identity,
        id: alertDestinations.id,
        kind: alertDestinations.kind,
        config: alertDestinations.config,
      })
      .from(alertDestinations)
      .where(needsRotation(alertDestinations.config, active))
      .limit(rotationBatchSize)
      .all();

    return { credentials, destinations };
  }

  changeCredentialEnvelope(
    identity: string,
    previous: EncryptedCredential,
    credential: EncryptedCredential,
  ): void {
    if (this.activeDataKey() !== credential.keyVersion) return;

    this.db
      .update(integrations)
      .set({ credential })
      .where(
        and(
          eq(integrations.identity, identity),
          envelopeMatches(integrations.credential, previous),
        ),
      )
      .run();
  }

  changeDestinationEnvelope(
    identity: string,
    previous: EncryptedCredential,
    config: EncryptedCredential,
  ): void {
    if (this.activeDataKey() !== config.keyVersion) return;

    this.db
      .update(alertDestinations)
      .set({ config })
      .where(
        and(
          eq(alertDestinations.identity, identity),
          envelopeMatches(alertDestinations.config, previous),
        ),
      )
      .run();
  }

  finishDataKeyRotation(active: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.activeDataKey() !== active) return false;

      const pending =
        this.db
          .select({ id: integrations.id })
          .from(integrations)
          .where(needsRotation(integrations.credential, active))
          .get() ??
        this.db
          .select({ id: alertDestinations.id })
          .from(alertDestinations)
          .where(needsRotation(alertDestinations.config, active))
          .get();

      if (pending) return false;

      this.db.delete(dataKeys).where(ne(dataKeys.version, active)).run();

      return true;
    });
  }

  private activeDataKey(): string | undefined {
    return this.db.select({ active: tenant.activeDataKey }).from(tenant).get()?.active;
  }

  private assertCurrentEncryptionKey(reference: CredentialReference): void {
    if (reference.source !== "encrypted-store") return;

    const active = this.activeDataKey();

    if (active && active !== reference.keyVersion) throw new Error("Tenant encryption key changed");
  }

  storedConfig(): TenantConfig {
    return this.db.select({ config: tenant.config }).from(tenant).get()?.config ?? {};
  }

  setStoredConfig(config: TenantConfig): void {
    this.db.update(tenant).set({ config }).run();
  }

  async destroy(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      await migrate(this.db, migrations);
    });
  }

  private assertProvisioned(): void {
    if (
      this.ctx.id.name?.startsWith("tenant/") &&
      !this.db.select({ id: tenant.id }).from(tenant).get()
    )
      throw new Error("Broker registry unavailable");
  }

  listIntegrations(): IntegrationMetadata[] {
    return this.db.select().from(integrations).orderBy(integrations.id).all().map(metadata);
  }

  getIntegration(id: string): IntegrationMetadata | undefined {
    const integration = this.findIntegration(id);

    return integration ? metadata(integration) : undefined;
  }

  createIntegration(integration: StoredIntegration): IntegrationCreation {
    this.assertProvisioned();
    this.assertCurrentEncryptionKey(integration.credential);

    return this.ctx.storage.transactionSync(() => {
      if (this.findIntegration(integration.id)) return "exists";

      const { total } = this.db.select({ total: count() }).from(integrations).get()!;

      if (total >= maxIntegrations) return "limit";

      this.db.insert(integrations).values(integration).run();

      return metadata(integration);
    });
  }

  credentialRevision(
    id: string,
  ): (IntegrationRevision & { credential: CredentialReference }) | undefined {
    return this.db
      .select({
        id: integrations.id,
        identity: integrations.identity,
        kind: integrations.kind,
        endpoint: integrations.endpoint,
        credential: integrations.credential,
        credentialVersion: integrations.credentialVersion,
      })
      .from(integrations)
      .where(eq(integrations.id, id))
      .get();
  }

  rotateCredential(
    revision: IntegrationRevision,
    credential: CredentialReference,
  ): IntegrationMetadata | undefined {
    this.assertCurrentEncryptionKey(credential);

    const integration = this.db
      .update(integrations)
      .set({
        updatedAt: Date.now(),
        credential,
        credentialVersion: revision.credentialVersion + 1,
      })
      .where(
        and(
          eq(integrations.identity, revision.identity),
          eq(integrations.credentialVersion, revision.credentialVersion),
        ),
      )
      .returning()
      .get();

    return integration ? metadata(integration) : undefined;
  }

  setIntegrationEnabled(id: string, enabled: boolean): IntegrationMetadata | undefined {
    return this.ctx.storage.transactionSync(() => {
      const integration = this.findIntegration(id);

      if (!integration || integration.enabled === enabled)
        return integration && metadata(integration);

      const updated = this.db
        .update(integrations)
        .set({ enabled, updatedAt: Date.now() })
        .where(eq(integrations.identity, integration.identity))
        .returning()
        .get()!;

      if (!enabled) this.revokeIntegrationGrants(integration.identity);

      return metadata(updated);
    });
  }

  deleteIntegration(id: string): void {
    this.ctx.storage.transactionSync(() => {
      const integration = this.db
        .delete(integrations)
        .where(eq(integrations.id, id))
        .returning({ identity: integrations.identity })
        .get();

      if (integration) this.revokeIntegrationGrants(integration.identity);
    });
  }

  listIssuerIntegrations(): string[] {
    return this.db
      .select({ id: integrations.id })
      .from(issuerIntegrations)
      .innerJoin(integrations, eq(issuerIntegrations.identity, integrations.identity))
      .orderBy(integrations.id)
      .all()
      .map(({ id }) => id);
  }

  setIssuerIntegrations(ids: string[]): string[] | undefined {
    return this.ctx.storage.transactionSync(() => {
      const selected = ids.length
        ? this.db
            .select({ id: integrations.id, identity: integrations.identity })
            .from(integrations)
            .where(inArray(integrations.id, ids))
            .orderBy(integrations.id)
            .all()
        : [];

      if (selected.length !== ids.length) return;

      this.db.delete(issuerIntegrations).run();

      if (selected.length) {
        this.db
          .insert(issuerIntegrations)
          .values(selected.map(({ identity }) => ({ identity })))
          .run();
      }

      return selected.map(({ id }) => id);
    });
  }

  async create(record: GrantRecord, principal: Principal): Promise<Issuance> {
    const now = Date.now();

    const result = this.ctx.storage.transactionSync((): Issuance => {
      const outsidePolicy = principal.integrations
        ? record.integrations.filter((id) => !principal.integrations!.includes(id))
        : [];

      if (outsidePolicy.length)
        return { status: "forbidden", reason: "not_in_policy", integrations: outsidePolicy };

      const known = this.db
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

      if (known.filter(({ kind }) => kind === "github").length > 1)
        return { status: "ambiguous_github" };

      // Bound all active rows, including simultaneous issuances from several workflow runs.
      const { total } = this.db
        .select({ total: count() })
        .from(grants)
        .where(gt(grants.expiresAt, now))
        .get()!;

      const { owned } = this.db
        .select({ owned: count() })
        .from(grants)
        .where(and(eq(grants.owner, record.owner), gt(grants.expiresAt, now)))
        .get()!;

      if (total >= maxActiveGrants || owned >= maxActiveGrantsPerOwner) return { status: "limit" };

      const { id, hash, owner, expiresAt, traceparent, label } = record;
      this.db
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

    if (result.status === "created") await this.scheduleCleanup(record.expiresAt);

    return result;
  }

  /** Active grants, newest first. Pass a principal to limit results to the issuer and its policy. */
  listGrants(principal?: Principal): GrantSummary[] {
    const now = Date.now();

    const names = new Map(
      this.db
        .select({ identity: integrations.identity, id: integrations.id })
        .from(integrations)
        .all()
        .map(({ identity, id }) => [identity, id]),
    );

    return this.db
      .select()
      .from(grants)
      .where(and(gt(grants.expiresAt, now), principal && this.grantScope(principal)))
      .orderBy(desc(grants.createdAt), grants.id)
      .all()
      .map((grant) => summary(grant, names));
  }

  /** Move an active grant's expiry to `expiresAt`, keeping its scope and token. */
  async renew(
    id: string,
    principal: Principal,
    expiresAt: number,
    request: TripRequest,
  ): Promise<Renewal> {
    const now = Date.now();

    const renewed = this.db
      .update(grants)
      .set({ expiresAt })
      .where(and(eq(grants.id, id), this.grantScope(principal), gt(grants.expiresAt, now)))
      .returning()
      .get();

    if (!renewed) return { status: "not_found", trip: this.tripCanary({ id }, request) };

    await this.scheduleCleanup(expiresAt);

    const names = new Map(
      this.db
        .select({ identity: integrations.identity, id: integrations.id })
        .from(integrations)
        .where(inArray(integrations.identity, renewed.permissions))
        .all()
        .map(({ identity, id: name }) => [identity, name]),
    );

    return { status: "renewed", grant: summary(renewed, names) };
  }

  /** Counts for the admin status view. */
  counts() {
    const now = Date.now();
    const { total } = this.db.select({ total: count() }).from(integrations).get()!;

    // Issuable means the issuer can mint a grant for it now: allowlisted and enabled.
    const { issuable } = this.db
      .select({ issuable: count() })
      .from(issuerIntegrations)
      .innerJoin(integrations, eq(issuerIntegrations.identity, integrations.identity))
      .where(eq(integrations.enabled, true))
      .get()!;

    const { active } = this.db
      .select({ active: count() })
      .from(grants)
      .where(gt(grants.expiresAt, now))
      .get()!;

    return { integrations: total, issuable, activeGrants: active };
  }

  allowIssuerIntegration(id: string): string[] | undefined {
    return this.ctx.storage.transactionSync(() => {
      const integration = this.findIntegration(id);

      if (!integration) return;

      this.db
        .insert(issuerIntegrations)
        .values({ identity: integration.identity })
        .onConflictDoNothing()
        .run();

      return this.listIssuerIntegrations();
    });
  }

  denyIssuerIntegration(id: string): string[] | undefined {
    return this.ctx.storage.transactionSync(() => {
      const integration = this.findIntegration(id);

      if (!integration) return;

      this.db
        .delete(issuerIntegrations)
        .where(eq(issuerIntegrations.identity, integration.identity))
        .run();

      return this.listIssuerIntegrations();
    });
  }

  /** Revoke a grant. Naming a canary instead trips it. */
  revoke(id: string, principal: Principal, request: TripRequest): Trip | undefined {
    const revoked = this.db
      .delete(grants)
      .where(and(eq(grants.id, id), this.grantScope(principal)))
      .returning({ id: grants.id })
      .get();

    return revoked ? undefined : this.tripCanary({ id }, request);
  }

  /** Record a canary's use and claim the alerts that are due. Returns nothing for other tokens. */
  tripCanary(match: CanaryMatch, request: TripRequest): Trip | undefined {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      const canary = this.db
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
      this.db.insert(canaryEvents).values({ canaryId: canary.id, event: recorded, at: now }).run();
      this.db.run(sql`
        DELETE FROM ${canaryEvents} WHERE ${canaryEvents.canaryId} = ${canary.id} AND ${canaryEvents.id} NOT IN (
          SELECT ${canaryEvents.id} FROM ${canaryEvents} WHERE ${canaryEvents.canaryId} = ${canary.id}
          ORDER BY ${canaryEvents.id} DESC LIMIT ${maxCanaryEvents}
        )
      `);

      const label = canary.label ?? canary.id;
      const deliveries: AlertDelivery[] = [];

      for (const destination of this.db.select().from(alertDestinations).all()) {
        const labels = [...new Set([...destination.pendingLabels, label])].slice(-20);

        const due =
          destination.lastAlertAt === null || now - destination.lastAlertAt >= alertIntervalMs;

        this.db
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
      };
    });
  }

  createCanary(record: CanaryRecord): CanaryIssuance {
    return this.ctx.storage.transactionSync((): CanaryIssuance => {
      const known = this.db
        .select({ id: integrations.id, kind: integrations.kind })
        .from(integrations)
        .where(inArray(integrations.id, record.integrations))
        .all();

      const missing = record.integrations.filter((id) => !known.some((row) => row.id === id));

      if (missing.length) return { status: "not_found", integrations: missing };

      const { total } = this.db.select({ total: count() }).from(canaries).get()!;

      if (total >= maxCanaries) return { status: "limit" };

      this.db
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

  listCanaries(): CanarySummary[] {
    return this.db
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
  getCanary(id: string): (CanarySummary & { events: Record<string, string>[] }) | undefined {
    const canary = this.listCanaries().find((row) => row.id === id);

    if (!canary) return;

    const events = this.db
      .select({ event: canaryEvents.event, at: canaryEvents.at })
      .from(canaryEvents)
      .where(eq(canaryEvents.canaryId, id))
      .orderBy(desc(canaryEvents.id))
      .all()
      .map(({ event, at }) => ({ at: new Date(at).toISOString(), ...event }));

    return { ...canary, events };
  }

  revokeCanary(id: string): boolean {
    return Boolean(
      this.db.delete(canaries).where(eq(canaries.id, id)).returning({ id: canaries.id }).get(),
    );
  }

  createDestination(record: DestinationRecord): "exists" | "limit" | DestinationSummary {
    this.assertProvisioned();
    this.assertCurrentEncryptionKey(record.config);

    return this.ctx.storage.transactionSync(() => {
      const existing = this.db
        .select({ id: alertDestinations.id })
        .from(alertDestinations)
        .where(eq(alertDestinations.id, record.id))
        .get();

      if (existing) return "exists";

      const { total } = this.db.select({ total: count() }).from(alertDestinations).get()!;

      if (total >= maxDestinations) return "limit";

      const created = this.db
        .insert(alertDestinations)
        .values({ ...record, createdAt: Date.now() })
        .returning()
        .get();

      return destinationSummary(created);
    });
  }

  listDestinations(): DestinationSummary[] {
    return this.db
      .select()
      .from(alertDestinations)
      .orderBy(alertDestinations.id)
      .all()
      .map(destinationSummary);
  }

  /** A destination's sealed configuration, for a test delivery. */
  destination(id: string): Omit<AlertDelivery, "trips" | "labels"> | undefined {
    return this.db
      .select({
        identity: alertDestinations.identity,
        id: alertDestinations.id,
        kind: alertDestinations.kind,
        config: alertDestinations.config,
      })
      .from(alertDestinations)
      .where(eq(alertDestinations.id, id))
      .get();
  }

  deleteDestination(id: string): void {
    this.db.delete(alertDestinations).where(eq(alertDestinations.id, id)).run();
  }

  recordDelivery(identity: string, status: number): void {
    this.db
      .update(alertDestinations)
      .set({ lastDeliveryAt: Date.now(), lastStatus: status })
      .where(eq(alertDestinations.identity, identity))
      .run();
  }

  authorize(
    hash: string,
    selector: IntegrationSelector,
    usesApiKeyHeader: boolean,
    limits: RequestLimits,
    request: TripRequest,
  ): Authorization {
    const now = Date.now();

    return this.ctx.storage.transactionSync((): Authorization => {
      const grant = this.db
        .select()
        .from(grants)
        .where(and(eq(grants.hash, hash), gt(grants.expiresAt, now)))
        .get();

      if (!grant) return { status: "invalid", trip: this.tripCanary({ hash }, request) };

      const candidates = this.db
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.enabled, true),
            inArray(integrations.identity, grant.permissions),
            selector.type === "github"
              ? eq(integrations.kind, "github")
              : eq(integrations.id, selector.id),
          ),
        )
        .all();

      const [integration] = candidates;

      if (
        candidates.length !== 1 ||
        (selector.type === "gateway" && integration.kind === "github")
      ) {
        return { status: "forbidden" };
      }

      if (usesApiKeyHeader && integration.kind !== "anthropic" && integration.kind !== "http")
        return { status: "invalid" };

      const { requestsPerMinute, concurrentRequests } = requestLimit(integration, limits);

      const scope = { grantId: grant.id, identity: integration.identity };
      const window = Math.floor(now / minuteMs);

      const counter = this.db
        .select()
        .from(usage)
        .where(and(eq(usage.grantId, scope.grantId), eq(usage.identity, scope.identity)))
        .get();

      const used = counter?.window === window ? counter.count : 0;

      const held = and(eq(leases.grantId, scope.grantId), eq(leases.identity, scope.identity));

      this.db
        .delete(leases)
        .where(and(held, lte(leases.expiresAt, now)))
        .run();
      const { active } = this.db.select({ active: count() }).from(leases).where(held).get()!;

      if (used >= requestsPerMinute || active >= concurrentRequests) {
        return { status: "busy" };
      }

      const leaseId = crypto.randomUUID();
      this.db
        .update(grants)
        .set({ requests: grant.requests + 1, lastUsedAt: now })
        .where(eq(grants.id, grant.id))
        .run();
      this.db
        .insert(usage)
        .values({ ...scope, window, count: used + 1 })
        .onConflictDoUpdate({
          target: [usage.grantId, usage.identity],
          set: { window, count: used + 1 },
        })
        .run();
      this.db
        .insert(leases)
        .values({ id: leaseId, ...scope, expiresAt: now + leaseTtlMs })
        .run();

      return { status: "allowed", leaseId, traceparent: grant.traceparent, integration };
    });
  }

  renewLease(leaseId: string): void {
    this.db
      .update(leases)
      .set({ expiresAt: Date.now() + leaseTtlMs })
      .where(eq(leases.id, leaseId))
      .run();
  }

  release(leaseId: string): void {
    this.db.delete(leases).where(eq(leases.id, leaseId)).run();
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.db.delete(grants).where(lte(grants.expiresAt, now)).run();
    this.db.delete(leases).where(lte(leases.expiresAt, now)).run();

    const next = this.db
      .select({ expire: min(grants.expiresAt) })
      .from(grants)
      .get();

    if (next?.expire != null) await this.scheduleCleanup(Math.min(next.expire, now + leaseTtlMs));
  }

  private grantScope(principal: Principal) {
    const owner = eq(grants.owner, principal.owner);

    if (principal.integrations === undefined) return owner;

    const allowed = this.db
      .select({ identity: integrations.identity })
      .from(integrations)
      .where(inArray(integrations.id, principal.integrations));

    const outsidePolicy = notInArray(sql`value`, allowed);

    return and(
      owner,
      sql`NOT EXISTS (SELECT 1 FROM json_each(${grants.permissions}) WHERE ${outsidePolicy})`,
    );
  }

  private findIntegration(id: string) {
    return this.db.select().from(integrations).where(eq(integrations.id, id)).get();
  }

  private revokeIntegrationGrants(identity: string): void {
    this.db
      .delete(grants)
      .where(sql`
      EXISTS (SELECT 1 FROM json_each(${grants.permissions}) WHERE value = ${identity})
    `)
      .run();
  }

  private async scheduleCleanup(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();

    if (current == null || at < current) await this.ctx.storage.setAlarm(at);
  }
}

type EnvelopeColumn =
  | typeof integrations.credential
  | typeof alertDestinations.config
  | typeof dataKeys.wrapped;

function needsRotation(column: EnvelopeColumn, active: string) {
  return sql`json_extract(${column}, '$.source') = 'encrypted-store' AND json_extract(${column}, '$.keyVersion') IS NOT ${active}`;
}

function envelopeMatches(column: EnvelopeColumn, expected: EncryptedCredential) {
  return sql`json_extract(${column}, '$.keyVersion') = ${expected.keyVersion}
    AND json_extract(${column}, '$.nonce') = ${expected.nonce}
    AND json_extract(${column}, '$.ciphertext') = ${expected.ciphertext}`;
}

function destinationSummary(row: typeof alertDestinations.$inferSelect): DestinationSummary {
  const { id, kind, host, headerNames, createdAt, lastAlertAt, lastDeliveryAt, lastStatus } = row;

  return { id, kind, host, headerNames, createdAt, lastAlertAt, lastDeliveryAt, lastStatus };
}

function metadata(integration: StoredIntegration): IntegrationMetadata {
  const { id, kind, enabled, credentialVersion, credential, createdAt, updatedAt } = integration;

  return {
    id,
    kind,
    enabled,
    credentialVersion,
    credentialSource: credential.source,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    ...(integration.endpoint && { endpoint: integration.endpoint }),
  };
}

function summary(
  grant: typeof grants.$inferSelect,
  names: ReadonlyMap<string, string>,
): GrantSummary {
  return {
    id: grant.id,
    owner: grant.owner,
    // A deleted integration revokes its grants, so every identity still has a name.
    integrations: grant.permissions.flatMap((identity) => names.get(identity) ?? []),
    label: grant.label,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    requests: grant.requests,
    lastUsedAt: grant.lastUsedAt,
  };
}
