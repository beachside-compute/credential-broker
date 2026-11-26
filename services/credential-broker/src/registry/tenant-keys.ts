import { and, count, eq, ne } from "drizzle-orm";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import type { TenantConfig } from "../config";
import type { CredentialReference, EncryptedCredential } from "../credentials/source";
import { integrations } from "../integrations/schema";
import { alertDestinations } from "../canaries/schema";
import { dataKeys, roleKeys, tenant } from "../tenants/schema";
import { initialTenantKeyVersion } from "../tenants/identity";
import type { TenantRole } from "../tenants/identity";
import type { TenantProvision, TenantKeyState, RegistryStore } from "./shared";
import { rotationBatchSize, needsRotation, envelopeMatches } from "./shared";

export function provision(
  store: RegistryStore,
  { id, dataKey, adminHash, issuerHash }: TenantProvision,
): void {
  store.ctx.storage.transactionSync(() => {
    const now = Date.now();
    store.db.delete(tenant).run();
    store.db.delete(roleKeys).run();
    store.db.delete(dataKeys).run();
    store.db
      .insert(tenant)
      .values({ id, createdAt: now, activeDataKey: initialTenantKeyVersion })
      .run();
    store.db
      .insert(roleKeys)
      .values([
        { role: "admin", hash: adminHash, createdAt: now },
        { role: "issuer", hash: issuerHash, createdAt: now },
      ])
      .run();
    store.db
      .insert(dataKeys)
      .values({
        version: initialTenantKeyVersion,
        wrapped: dataKey,
        createdAt: now,
      })
      .run();
  });
}

export function role(store: RegistryStore, hash: string): TenantRole | undefined {
  return store.db
    .select({ role: roleKeys.role })
    .from(roleKeys)
    .where(eq(roleKeys.hash, hash))
    .get()?.role;
}

export function hasRoleKey(store: RegistryStore, role: TenantRole): boolean {
  return Boolean(
    store.db.select({ role: roleKeys.role }).from(roleKeys).where(eq(roleKeys.role, role)).get(),
  );
}

export function setRoleKey(store: RegistryStore, role: TenantRole, hash: string): void {
  const values = { hash, createdAt: Date.now() };
  store.db
    .insert(roleKeys)
    .values({ role, ...values })
    .onConflictDoUpdate({
      target: roleKeys.role,
      set: values,
    })
    .run();
}

export function tenantKeyState(store: RegistryStore): TenantKeyState {
  return readDataKeys(store, activeDataKey(store) ?? initialTenantKeyVersion);
}

export function readDataKeys(store: RegistryStore, active: string): TenantKeyState {
  return {
    active,
    keys: store.db
      .select({ version: dataKeys.version, wrapped: dataKeys.wrapped })
      .from(dataKeys)
      .orderBy(dataKeys.version)
      .all(),
  };
}

export function alertKeyState(store: RegistryStore): TenantKeyState | null {
  const active = activeDataKey(store);

  return active ? readDataKeys(store, active) : null;
}

export function rewrapDataKeys(
  store: RegistryStore,
  version: string,
  previous: EncryptedCredential,
  wrapped: EncryptedCredential,
): boolean {
  return Boolean(
    store.db
      .update(dataKeys)
      .set({ wrapped })
      .where(and(eq(dataKeys.version, version), envelopeMatches(dataKeys.wrapped, previous)))
      .returning({ version: dataKeys.version })
      .get(),
  );
}

export function beginDataKeyRotation(
  store: RegistryStore,
  expected: string,
  version: string,
  wrapped: EncryptedCredential,
): boolean {
  return store.ctx.storage.transactionSync(() => {
    if (
      activeDataKey(store) !== expected ||
      store.db.select({ total: count() }).from(dataKeys).get()!.total !== 1
    )
      return false;

    store.db.insert(dataKeys).values({ version, wrapped, createdAt: Date.now() }).run();
    store.db.update(tenant).set({ activeDataKey: version }).run();

    return true;
  });
}

export function dataKeyRotationBatch(store: RegistryStore, active: string) {
  if (activeDataKey(store) !== active) return;

  const credentials = store.db
    .select()
    .from(integrations)
    .where(needsRotation(integrations.credential, active))
    .orderBy(integrations.identity)
    .limit(rotationBatchSize)
    .all();

  const destinations = store.db
    .select({
      identity: alertDestinations.identity,
      id: alertDestinations.id,
      kind: alertDestinations.kind,
      config: alertDestinations.config,
    })
    .from(alertDestinations)
    .where(needsRotation(alertDestinations.config, active))
    .orderBy(alertDestinations.identity)
    .limit(rotationBatchSize)
    .all();

  return { credentials, destinations };
}

export function changeCredentialEnvelope(
  store: RegistryStore,
  identity: string,
  previous: EncryptedCredential,
  credential: EncryptedCredential,
): boolean {
  if (activeDataKey(store) !== credential.keyVersion) return false;

  return Boolean(
    store.db
      .update(integrations)
      .set({ credential })
      .where(
        and(
          eq(integrations.identity, identity),
          envelopeMatches(integrations.credential, previous),
        ),
      )
      .returning({ identity: integrations.identity })
      .get(),
  );
}

export function changeDestinationEnvelope(
  store: RegistryStore,
  identity: string,
  previous: EncryptedCredential,
  config: EncryptedCredential,
): boolean {
  if (activeDataKey(store) !== config.keyVersion) return false;

  return Boolean(
    store.db
      .update(alertDestinations)
      .set({ config })
      .where(
        and(
          eq(alertDestinations.identity, identity),
          envelopeMatches(alertDestinations.config, previous),
        ),
      )
      .returning({ identity: alertDestinations.identity })
      .get(),
  );
}

export function finishDataKeyRotation(store: RegistryStore, active: string): boolean {
  return store.ctx.storage.transactionSync(() => {
    if (activeDataKey(store) !== active) return false;

    const pending =
      store.db
        .select({ id: integrations.id })
        .from(integrations)
        .where(needsRotation(integrations.credential, active))
        .get() ??
      store.db
        .select({ id: alertDestinations.id })
        .from(alertDestinations)
        .where(needsRotation(alertDestinations.config, active))
        .get();

    if (
      pending ||
      !store.db
        .select({ version: dataKeys.version })
        .from(dataKeys)
        .where(eq(dataKeys.version, active))
        .get()
    )
      return false;

    store.db.delete(dataKeys).where(ne(dataKeys.version, active)).run();

    return true;
  });
}

export function activeDataKey(store: RegistryStore): string | undefined {
  return store.db.select({ active: tenant.activeDataKey }).from(tenant).get()?.active;
}

export function assertCurrentEncryptionKey(
  store: RegistryStore,
  reference: CredentialReference,
): void {
  if (reference.source !== "encrypted-store") return;

  const active = activeDataKey(store);

  if (active && active !== reference.keyVersion) throw new Error("tenant_key_changed");
}

export function storedConfig(store: RegistryStore): TenantConfig {
  return store.db.select({ config: tenant.config }).from(tenant).get()?.config ?? {};
}

export function setStoredConfig(store: RegistryStore, config: TenantConfig): void {
  store.db.update(tenant).set({ config }).run();
}

export async function destroy(store: RegistryStore): Promise<void> {
  await store.ctx.blockConcurrencyWhile(async () => {
    await store.ctx.storage.deleteAlarm();
    await store.ctx.storage.deleteAll();
    await migrate(store.db, migrations);
  });
}

export function assertProvisioned(store: RegistryStore): void {
  if (
    store.ctx.id.name?.startsWith("tenant/") &&
    !store.db.select({ id: tenant.id }).from(tenant).get()
  )
    throw new Error("Broker registry unavailable");
}
