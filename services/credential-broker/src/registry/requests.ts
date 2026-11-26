import { and, count, eq, gt, inArray, lte, min } from "drizzle-orm";
import { requestLimit, tenantConfigFor } from "../config";
import type { RequestLimits } from "../config";
import { brokerIntegration, kindsIn } from "../integrations/definitions";
import { integrations } from "../integrations/schema";
import type { IntegrationSelector } from "../integrations/types";
import { grants, leases, usage } from "../grants/schema";
import type { TripRequest } from "../canaries/types";
import { tenant } from "../tenants/schema";
import type { Authorization, RegistryStore } from "./shared";
import { minuteMs, leaseTtlMs } from "./shared";
import { readDataKeys } from "./tenant-keys";
import { scheduleCleanup } from "./grants";
import { tripCanary } from "./canaries";

export function authorize(
  store: RegistryStore,
  hash: string,
  selector: IntegrationSelector,
  usesApiKeyHeader: boolean,
  deploymentLimits: RequestLimits | undefined,
  request: TripRequest,
): Authorization {
  const now = Date.now();

  return store.ctx.storage.transactionSync((): Authorization => {
    const grant = store.db
      .select()
      .from(grants)
      .where(and(eq(grants.hash, hash), gt(grants.expiresAt, now)))
      .get();

    if (!grant) return { status: "invalid", trip: tripCanary(store, { hash }, request) };

    const candidates = store.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.enabled, true),
          inArray(integrations.identity, grant.permissions),
          selector.type === "github"
            ? inArray(integrations.kind, kindsIn("github"))
            : eq(integrations.id, selector.id),
        ),
      )
      .all();

    const [integration] = candidates;

    if (
      candidates.length !== 1 ||
      (selector.type === "gateway" && brokerIntegration(integration.kind).family === "github")
    ) {
      return { status: "forbidden" };
    }

    if (usesApiKeyHeader && !brokerIntegration(integration.kind).apiKeyHeader)
      return { status: "invalid" };

    const hosted =
      deploymentLimits === undefined ? store.db.select().from(tenant).get() : undefined;

    if (deploymentLimits === undefined && !hosted) return { status: "invalid" };

    const limits = hosted
      ? tenantConfigFor(hosted.id).parse(hosted.config ?? {}).limits
      : deploymentLimits;

    const { requestsPerMinute, concurrentRequests } = requestLimit(integration, limits ?? {});

    const scope = { grantId: grant.id, identity: integration.identity };
    const window = Math.floor(now / minuteMs);

    const counter = store.db
      .select()
      .from(usage)
      .where(and(eq(usage.grantId, scope.grantId), eq(usage.identity, scope.identity)))
      .get();

    const used = counter?.window === window ? counter.count : 0;

    const held = and(eq(leases.grantId, scope.grantId), eq(leases.identity, scope.identity));

    store.db
      .delete(leases)
      .where(and(held, lte(leases.expiresAt, now)))
      .run();
    const { active } = store.db.select({ active: count() }).from(leases).where(held).get()!;

    if (used >= requestsPerMinute || active >= concurrentRequests) {
      return { status: "busy" };
    }

    const leaseId = crypto.randomUUID();
    store.db
      .update(grants)
      .set({ requests: grant.requests + 1, lastUsedAt: now })
      .where(eq(grants.id, grant.id))
      .run();
    store.db
      .insert(usage)
      .values({ ...scope, window, count: used + 1 })
      .onConflictDoUpdate({
        target: [usage.grantId, usage.identity],
        set: { window, count: used + 1 },
      })
      .run();
    store.db
      .insert(leases)
      .values({ id: leaseId, ...scope, expiresAt: now + leaseTtlMs })
      .run();

    const keyState =
      hosted && integration.credential.source === "encrypted-store"
        ? readDataKeys(store, hosted.activeDataKey)
        : null;

    return { status: "allowed", leaseId, traceparent: grant.traceparent, integration, keyState };
  });
}

export function renewLease(store: RegistryStore, leaseId: string): void {
  store.db
    .update(leases)
    .set({ expiresAt: Date.now() + leaseTtlMs })
    .where(eq(leases.id, leaseId))
    .run();
}

export function release(store: RegistryStore, leaseId: string): void {
  store.db.delete(leases).where(eq(leases.id, leaseId)).run();
}

export async function cleanup(store: RegistryStore): Promise<void> {
  const now = Date.now();
  store.db.delete(grants).where(lte(grants.expiresAt, now)).run();
  store.db.delete(leases).where(lte(leases.expiresAt, now)).run();

  const next = store.db
    .select({ expire: min(grants.expiresAt) })
    .from(grants)
    .get();

  if (next?.expire != null) await scheduleCleanup(store, Math.min(next.expire, now + leaseTtlMs));
}
