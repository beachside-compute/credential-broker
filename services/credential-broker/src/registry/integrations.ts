import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { CredentialReference } from "../credentials/source";
import { integrations, issuerIntegrations } from "../integrations/schema";
import { maxIntegrations } from "../integrations/types";
import type {
  IntegrationMetadata,
  IntegrationRevision,
  StoredIntegration,
} from "../integrations/types";
import { grants } from "../grants/schema";
import type { IntegrationCreation, RegistryStore } from "./shared";
import { metadata } from "./shared";
import { assertCurrentEncryptionKey, assertProvisioned } from "./tenant-keys";

export function listIntegrations(store: RegistryStore): IntegrationMetadata[] {
  return store.db.select().from(integrations).orderBy(integrations.id).all().map(metadata);
}

export function getIntegration(store: RegistryStore, id: string): IntegrationMetadata | undefined {
  const integration = findIntegration(store, id);

  return integration ? metadata(integration) : undefined;
}

export function createIntegration(
  store: RegistryStore,
  integration: StoredIntegration,
): IntegrationCreation {
  assertProvisioned(store);
  assertCurrentEncryptionKey(store, integration.credential);

  return store.ctx.storage.transactionSync(() => {
    if (findIntegration(store, integration.id)) return "exists";

    const { total } = store.db.select({ total: count() }).from(integrations).get()!;

    if (total >= maxIntegrations) return "limit";

    store.db.insert(integrations).values(integration).run();

    return metadata(integration);
  });
}

export function credentialRevision(
  store: RegistryStore,
  id: string,
): (IntegrationRevision & { credential: CredentialReference }) | undefined {
  return store.db
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

export function rotateCredential(
  store: RegistryStore,
  revision: IntegrationRevision,
  credential: CredentialReference,
): IntegrationMetadata | undefined {
  assertCurrentEncryptionKey(store, credential);

  const integration = store.db
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

export function setIntegrationEnabled(
  store: RegistryStore,
  id: string,
  enabled: boolean,
): IntegrationMetadata | undefined {
  return store.ctx.storage.transactionSync(() => {
    const integration = findIntegration(store, id);

    if (!integration || integration.enabled === enabled)
      return integration && metadata(integration);

    const updated = store.db
      .update(integrations)
      .set({ enabled, updatedAt: Date.now() })
      .where(eq(integrations.identity, integration.identity))
      .returning()
      .get()!;

    if (!enabled) revokeIntegrationGrants(store, integration.identity);

    return metadata(updated);
  });
}

export function deleteIntegration(store: RegistryStore, id: string): void {
  store.ctx.storage.transactionSync(() => {
    const integration = store.db
      .delete(integrations)
      .where(eq(integrations.id, id))
      .returning({ identity: integrations.identity })
      .get();

    if (integration) revokeIntegrationGrants(store, integration.identity);
  });
}

export function listIssuerIntegrations(store: RegistryStore): string[] {
  return store.db
    .select({ id: integrations.id })
    .from(issuerIntegrations)
    .innerJoin(integrations, eq(issuerIntegrations.identity, integrations.identity))
    .orderBy(integrations.id)
    .all()
    .map(({ id }) => id);
}

export function setIssuerIntegrations(store: RegistryStore, ids: string[]): string[] | undefined {
  return store.ctx.storage.transactionSync(() => {
    const selected = ids.length
      ? store.db
          .select({ id: integrations.id, identity: integrations.identity })
          .from(integrations)
          .where(inArray(integrations.id, ids))
          .orderBy(integrations.id)
          .all()
      : [];

    if (selected.length !== ids.length) return;

    store.db.delete(issuerIntegrations).run();

    if (selected.length) {
      store.db
        .insert(issuerIntegrations)
        .values(selected.map(({ identity }) => ({ identity })))
        .run();
    }

    return selected.map(({ id }) => id);
  });
}

export function allowIssuerIntegration(store: RegistryStore, id: string): string[] | undefined {
  return store.ctx.storage.transactionSync(() => {
    const integration = findIntegration(store, id);

    if (!integration) return;

    store.db
      .insert(issuerIntegrations)
      .values({ identity: integration.identity })
      .onConflictDoNothing()
      .run();

    return listIssuerIntegrations(store);
  });
}

export function denyIssuerIntegration(store: RegistryStore, id: string): string[] | undefined {
  return store.ctx.storage.transactionSync(() => {
    const integration = findIntegration(store, id);

    if (!integration) return;

    store.db
      .delete(issuerIntegrations)
      .where(eq(issuerIntegrations.identity, integration.identity))
      .run();

    return listIssuerIntegrations(store);
  });
}

export function findIntegration(store: RegistryStore, id: string) {
  return store.db.select().from(integrations).where(eq(integrations.id, id)).get();
}

export function revokeIntegrationGrants(store: RegistryStore, identity: string): void {
  store.db
    .delete(grants)
    .where(sql`
    EXISTS (SELECT 1 FROM json_each(${grants.permissions}) WHERE value = ${identity})
  `)
    .run();
}
