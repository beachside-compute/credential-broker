import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { EncryptedCredential } from "../credentials/source";
import { integrations } from "../integrations/schema";
import type {
  IntegrationKind,
  IntegrationMetadata,
  StoredIntegration,
} from "../integrations/types";
import { grants } from "../grants/schema";
import { alertDestinations } from "../canaries/schema";
import type { AlertDelivery, DestinationSummary, Trip } from "../canaries/types";
import { dataKeys } from "../tenants/schema";

export interface TenantProvision {
  id: string;
  dataKey: EncryptedCredential;
  adminHash: string;
  issuerHash: string;
}

export const rotationBatchSize = 8;

export const minuteMs = 60_000;

export const maxActiveGrants = 1000;

export const maxActiveGrantsPerOwner = 100;

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

export type Issuance =
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

export type Renewal =
  | { status: "renewed"; grant: GrantSummary }
  | { status: "not_found"; trip?: Trip };

export type CanaryMatch = { hash: string } | { id: string };

export interface CanaryRecord {
  id: string;
  hash: string;
  integrations: string[];
  label?: string;
  note?: string;
}

export type CanaryIssuance =
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

export type IntegrationCreation = "exists" | "limit" | IntegrationMetadata;

export interface TenantKeyState {
  active: string;
  keys: { version: string; wrapped: EncryptedCredential }[];
}

export type Authorization =
  | {
      status: "allowed";
      leaseId: string;
      traceparent: string | null;
      integration: StoredIntegration;
      keyState: TenantKeyState | null;
    }
  | { status: "invalid"; trip?: Trip }
  | { status: "forbidden" | "busy" };

export type EnvelopeColumn =
  | typeof integrations.credential
  | typeof alertDestinations.config
  | typeof dataKeys.wrapped;

export function needsRotation(column: EnvelopeColumn, active: string) {
  return sql`json_extract(${column}, '$.source') = 'encrypted-store' AND json_extract(${column}, '$.keyVersion') IS NOT ${active}`;
}

export function envelopeMatches(column: EnvelopeColumn, expected: EncryptedCredential) {
  return sql`json_extract(${column}, '$.keyVersion') = ${expected.keyVersion}
    AND json_extract(${column}, '$.nonce') = ${expected.nonce}
    AND json_extract(${column}, '$.ciphertext') = ${expected.ciphertext}`;
}

export function destinationSummary(row: typeof alertDestinations.$inferSelect): DestinationSummary {
  const { id, kind, host, headerNames, createdAt, lastAlertAt, lastDeliveryAt, lastStatus } = row;

  return { id, kind, host, headerNames, createdAt, lastAlertAt, lastDeliveryAt, lastStatus };
}

export function metadata(integration: StoredIntegration): IntegrationMetadata {
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

export function summary(
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

export interface RegistryStore {
  db: ReturnType<typeof drizzle>;
  ctx: DurableObjectState;
}
