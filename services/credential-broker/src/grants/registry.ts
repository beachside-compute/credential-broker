import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import type { Principal } from "../auth";
import type { RequestLimits, TenantConfig } from "../config";
import type { CredentialReference, EncryptedCredential } from "../credentials/source";
import type {
  IntegrationRevision,
  IntegrationSelector,
  StoredIntegration,
} from "../integrations/types";
import type { TripRequest } from "../canaries/types";
import type { TenantRole } from "../tenants/identity";
import type {
  TenantProvision,
  GrantRecord,
  CanaryMatch,
  CanaryRecord,
  DestinationRecord,
  RegistryStore,
} from "../registry/shared";
import * as tenantKeys from "../registry/tenant-keys";
import * as integrationStore from "../registry/integrations";
import * as grantStore from "../registry/grants";
import * as canaryStore from "../registry/canaries";
import * as requestStore from "../registry/requests";

export type {
  Authorization,
  CanaryRecord,
  DestinationRecord,
  GrantRecord,
  GrantSummary,
  IssuanceRefusal,
  TenantKeyState,
  TenantProvision,
} from "../registry/shared";

export { leaseTtlMs } from "../registry/shared";

export class GrantRegistry extends DurableObject {
  private readonly store: RegistryStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    this.store = { db, ctx };
    ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
    });
  }

  provision(input: TenantProvision) {
    return tenantKeys.provision(this.store, input);
  }

  role(hash: string) {
    return tenantKeys.role(this.store, hash);
  }

  hasRoleKey(role: TenantRole) {
    return tenantKeys.hasRoleKey(this.store, role);
  }

  setRoleKey(role: TenantRole, hash: string) {
    return tenantKeys.setRoleKey(this.store, role, hash);
  }

  dataKeys() {
    return tenantKeys.tenantKeyState(this.store);
  }

  rewrapDataKeys(version: string, previous: EncryptedCredential, wrapped: EncryptedCredential) {
    return tenantKeys.rewrapDataKeys(this.store, version, previous, wrapped);
  }

  beginDataKeyRotation(expected: string, version: string, wrapped: EncryptedCredential) {
    return tenantKeys.beginDataKeyRotation(this.store, expected, version, wrapped);
  }

  dataKeyRotationBatch(active: string) {
    return tenantKeys.dataKeyRotationBatch(this.store, active);
  }

  changeCredentialEnvelope(
    identity: string,
    previous: EncryptedCredential,
    credential: EncryptedCredential,
  ) {
    return tenantKeys.changeCredentialEnvelope(this.store, identity, previous, credential);
  }

  changeDestinationEnvelope(
    identity: string,
    previous: EncryptedCredential,
    config: EncryptedCredential,
  ) {
    return tenantKeys.changeDestinationEnvelope(this.store, identity, previous, config);
  }

  finishDataKeyRotation(active: string) {
    return tenantKeys.finishDataKeyRotation(this.store, active);
  }

  storedConfig() {
    return tenantKeys.storedConfig(this.store);
  }

  setStoredConfig(config: TenantConfig) {
    return tenantKeys.setStoredConfig(this.store, config);
  }

  destroy() {
    return tenantKeys.destroy(this.store);
  }

  listIntegrations() {
    return integrationStore.listIntegrations(this.store);
  }

  getIntegration(id: string) {
    return integrationStore.getIntegration(this.store, id);
  }

  createIntegration(integration: StoredIntegration) {
    return integrationStore.createIntegration(this.store, integration);
  }

  credentialRevision(id: string) {
    return integrationStore.credentialRevision(this.store, id);
  }

  rotateCredential(revision: IntegrationRevision, credential: CredentialReference) {
    return integrationStore.rotateCredential(this.store, revision, credential);
  }

  setIntegrationEnabled(id: string, enabled: boolean) {
    return integrationStore.setIntegrationEnabled(this.store, id, enabled);
  }

  deleteIntegration(id: string) {
    return integrationStore.deleteIntegration(this.store, id);
  }

  listIssuerIntegrations() {
    return integrationStore.listIssuerIntegrations(this.store);
  }

  setIssuerIntegrations(ids: string[]) {
    return integrationStore.setIssuerIntegrations(this.store, ids);
  }

  create(record: GrantRecord, principal: Principal) {
    return grantStore.create(this.store, record, principal);
  }

  /** Active grants, newest first. Pass a principal to limit results to the issuer and its policy. */
  listGrants(principal?: Principal) {
    return grantStore.listGrants(this.store, principal);
  }

  /** Move an active grant's expiry to `expiresAt`, keeping its scope and token. */
  renew(id: string, principal: Principal, expiresAt: number, request: TripRequest) {
    return grantStore.renew(this.store, id, principal, expiresAt, request);
  }

  /** Counts for the admin status view. */
  counts() {
    return grantStore.counts(this.store);
  }

  allowIssuerIntegration(id: string) {
    return integrationStore.allowIssuerIntegration(this.store, id);
  }

  denyIssuerIntegration(id: string) {
    return integrationStore.denyIssuerIntegration(this.store, id);
  }

  /** Revoke a grant. Naming a canary instead trips it. */
  revoke(id: string, principal: Principal, request: TripRequest) {
    return grantStore.revoke(this.store, id, principal, request);
  }

  /** Record a canary's use and claim the alerts that are due. Returns nothing for other tokens. */
  tripCanary(match: CanaryMatch, request: TripRequest) {
    return canaryStore.tripCanary(this.store, match, request);
  }

  createCanary(record: CanaryRecord) {
    return canaryStore.createCanary(this.store, record);
  }

  listCanaries() {
    return canaryStore.listCanaries(this.store);
  }

  /** A canary with its most recent trips, newest first. */
  getCanary(id: string) {
    return canaryStore.getCanary(this.store, id);
  }

  revokeCanary(id: string) {
    return canaryStore.revokeCanary(this.store, id);
  }

  createDestination(record: DestinationRecord) {
    return canaryStore.createDestination(this.store, record);
  }

  listDestinations() {
    return canaryStore.listDestinations(this.store);
  }

  /** A destination's sealed configuration, for a test delivery. */
  destination(id: string) {
    return canaryStore.destination(this.store, id);
  }

  deleteDestination(id: string) {
    return canaryStore.deleteDestination(this.store, id);
  }

  recordDelivery(identity: string, status: number) {
    return canaryStore.recordDelivery(this.store, identity, status);
  }

  authorize(
    hash: string,
    selector: IntegrationSelector,
    usesApiKeyHeader: boolean,
    deploymentLimits: RequestLimits | undefined,
    request: TripRequest,
  ) {
    return requestStore.authorize(
      this.store,
      hash,
      selector,
      usesApiKeyHeader,
      deploymentLimits,
      request,
    );
  }

  renewLease(leaseId: string) {
    return requestStore.renewLease(this.store, leaseId);
  }

  release(leaseId: string) {
    return requestStore.release(this.store, leaseId);
  }

  override async alarm() {
    await requestStore.cleanup(this.store);
  }
}
