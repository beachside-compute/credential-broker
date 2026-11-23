import { DurableObject } from "cloudflare:workers";
import { and, count, desc, eq, gt, inArray, lte, min, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import type { Principal } from "../auth";
import { requestLimit } from "../config";
import type { RequestLimits } from "../config";
import type { CredentialReference } from "../credentials/source";
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

type Renewal = { status: "renewed"; grant: GrantSummary } | { status: "not_found" };

type IntegrationCreation = "exists" | "limit" | IntegrationMetadata;

export type Authorization =
  | {
      status: "allowed";
      leaseId: string;
      traceparent: string | null;
      integration: StoredIntegration;
    }
  | { status: "invalid" | "forbidden" | "busy" };

export class GrantRegistry extends DurableObject {
  private readonly db;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  listIntegrations(): IntegrationMetadata[] {
    return this.db.select().from(integrations).orderBy(integrations.id).all().map(metadata);
  }

  getIntegration(id: string): IntegrationMetadata | undefined {
    const integration = this.findIntegration(id);

    return integration ? metadata(integration) : undefined;
  }

  createIntegration(integration: StoredIntegration): IntegrationCreation {
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

  /** Active grants, newest first. Pass an owner to see only that issuer's grants. */
  listGrants(owner?: string): GrantSummary[] {
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
      .where(
        owner === undefined
          ? gt(grants.expiresAt, now)
          : and(eq(grants.owner, owner), gt(grants.expiresAt, now)),
      )
      .orderBy(desc(grants.createdAt), grants.id)
      .all()
      .map((grant) => summary(grant, names));
  }

  /** Move an active grant's expiry to `expiresAt`, keeping its scope and token. */
  async renew(id: string, owner: string, expiresAt: number): Promise<Renewal> {
    const now = Date.now();

    const renewed = this.db
      .update(grants)
      .set({ expiresAt })
      .where(and(eq(grants.id, id), eq(grants.owner, owner), gt(grants.expiresAt, now)))
      .returning()
      .get();

    if (!renewed) return { status: "not_found" };

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

  revoke(id: string, owner: string): void {
    this.db
      .delete(grants)
      .where(and(eq(grants.id, id), eq(grants.owner, owner)))
      .run();
  }

  authorize(
    hash: string,
    selector: IntegrationSelector,
    usesApiKeyHeader: boolean,
    limits: RequestLimits,
  ): Authorization {
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const grant = this.db
        .select()
        .from(grants)
        .where(and(eq(grants.hash, hash), gt(grants.expiresAt, now)))
        .get();

      if (!grant) return { status: "invalid" };

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
