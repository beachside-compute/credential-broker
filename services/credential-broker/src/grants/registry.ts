import { DurableObject } from "cloudflare:workers";
import { and, count, eq, gt, inArray, lte, min, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import type { Principal } from "../auth";
import type { CredentialReference } from "../credentials/source";
import { integrations, issuerIntegrations } from "../integrations/schema";
import { maxIntegrations } from "../integrations/types";
import type {
  IntegrationMetadata,
  IntegrationRevision,
  IntegrationSelector,
  StoredIntegration,
} from "../integrations/types";
import { grants, leases } from "./schema";

const minuteMs = 60_000;

const maxActiveGrants = 1000;

const maxActiveGrantsPerOwner = 100;

const maxRequestsPerMinute = 120;

const maxConcurrentRequests = 8;

export interface GrantRecord {
  id: string;
  hash: string;
  owner: string;
  integrations: string[];
  expiresAt: number;
  traceparent?: string;
}

type Issuance = "created" | "forbidden" | "ambiguous_github" | "limit";

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
      if (
        principal.integrations &&
        record.integrations.some((id) => !principal.integrations!.includes(id))
      ) {
        return "forbidden";
      }

      const selected = this.db
        .select({ identity: integrations.identity, kind: integrations.kind })
        .from(issuerIntegrations)
        .innerJoin(integrations, eq(issuerIntegrations.identity, integrations.identity))
        .where(and(eq(integrations.enabled, true), inArray(integrations.id, record.integrations)))
        .all();

      if (selected.length !== record.integrations.length) return "forbidden";

      if (selected.filter(({ kind }) => kind === "github").length > 1) return "ambiguous_github";

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

      if (total >= maxActiveGrants || owned >= maxActiveGrantsPerOwner) return "limit";

      const { id, hash, owner, expiresAt, traceparent } = record;
      this.db
        .insert(grants)
        .values({
          id,
          hash,
          owner,
          expiresAt,
          traceparent,
          permissions: selected.map(({ identity }) => identity),
        })
        .run();

      return "created";
    });

    if (result === "created") await this.scheduleCleanup(record.expiresAt);

    return result;
  }

  revoke(id: string, owner: string): void {
    this.db
      .delete(grants)
      .where(and(eq(grants.id, id), eq(grants.owner, owner)))
      .run();
  }

  authorize(hash: string, selector: IntegrationSelector, usesApiKeyHeader: boolean): Authorization {
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

      const window = Math.floor(now / minuteMs);
      const used = grant.rateWindow === window ? grant.rateCount : 0;

      const { active } = this.db
        .select({ active: count() })
        .from(leases)
        .where(eq(leases.grantId, grant.id))
        .get()!;

      if (used >= maxRequestsPerMinute || active >= maxConcurrentRequests) {
        return { status: "busy" };
      }

      const leaseId = crypto.randomUUID();
      this.db
        .update(grants)
        .set({ rateWindow: window, rateCount: used + 1 })
        .where(eq(grants.id, grant.id))
        .run();
      this.db.insert(leases).values({ id: leaseId, grantId: grant.id }).run();

      return { status: "allowed", leaseId, traceparent: grant.traceparent, integration };
    });
  }

  release(leaseId: string): void {
    this.db.delete(leases).where(eq(leases.id, leaseId)).run();
  }

  override async alarm(): Promise<void> {
    this.db.delete(grants).where(lte(grants.expiresAt, Date.now())).run();

    const next = this.db
      .select({ expire: min(grants.expiresAt) })
      .from(grants)
      .get();

    if (next?.expire != null) await this.scheduleCleanup(next.expire);
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
