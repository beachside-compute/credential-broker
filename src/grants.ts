/* oxlint-disable anti-slop/no-runtime-typeof -- Validate broker grant listings at the HTTP trust boundary. */
import { CredentialBrokerError, integrationName } from "./transport.js";

export const grantId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const grantLabel = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/;

/** An active grant as a listing shows it. The token is never listed. */
export interface BrokerGrantSummary {
  readonly id: string;
  readonly integrations: readonly string[];
  readonly label: string | null;
  readonly createdAt: string | null;
  readonly expiresAt: string;
  readonly requests: number;
  readonly lastUsedAt: string | null;
  /** The issuing authority. Admin listings only. */
  readonly owner?: string;
}

export interface BrokerStatus {
  readonly apiVersion: number;
  readonly role: "admin" | "issuer" | "github-actions";
  readonly limits: { readonly maxGrantTtlSeconds: number };
  readonly counts?: {
    readonly integrations: number;
    readonly issuable: number;
    readonly activeGrants: number;
  };
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Records from an untrusted HTTP array are parsed here.
export function grantSummary(reply: unknown, withOwner: boolean): BrokerGrantSummary {
  const invalid = () =>
    new CredentialBrokerError("INVALID_RESPONSE", "Credential broker returned an invalid grant");

  if (
    !reply ||
    typeof reply !== "object" ||
    !(
      "id" in reply &&
      "integrations" in reply &&
      "label" in reply &&
      "createdAt" in reply &&
      "expiresAt" in reply &&
      "requests" in reply &&
      "lastUsedAt" in reply
    )
  )
    throw invalid();

  const { id, integrations, label, createdAt, expiresAt, requests, lastUsedAt } = reply;
  const owner = "owner" in reply ? reply.owner : undefined;

  if (
    typeof id !== "string" ||
    !grantId.test(id) ||
    !Array.isArray(integrations) ||
    !integrations.every((name) => typeof name === "string" && integrationName.test(name)) ||
    !(label === null || (typeof label === "string" && grantLabel.test(label))) ||
    !(createdAt === null || (typeof createdAt === "string" && isTimestamp(createdAt))) ||
    typeof expiresAt !== "string" ||
    !isTimestamp(expiresAt) ||
    typeof requests !== "number" ||
    !Number.isSafeInteger(requests) ||
    requests < 0 ||
    !(lastUsedAt === null || (typeof lastUsedAt === "string" && isTimestamp(lastUsedAt))) ||
    (withOwner && (typeof owner !== "string" || owner.length > 256))
  )
    throw invalid();

  return {
    id,
    integrations: integrations.map(String),
    label,
    createdAt,
    expiresAt,
    requests,
    lastUsedAt,
    ...(withOwner && typeof owner === "string" && { owner }),
  };
}

/** Parse `{ grants: [...] }` from a broker listing. Shared with the admin client. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- An untrusted HTTP body is parsed here.
export function grantListing(reply: unknown, withOwner: boolean): BrokerGrantSummary[] {
  if (
    !reply ||
    typeof reply !== "object" ||
    !("grants" in reply) ||
    !Array.isArray(reply.grants) ||
    reply.grants.length > 1_000
  )
    throw new CredentialBrokerError(
      "INVALID_RESPONSE",
      "Credential broker returned an invalid grant list",
    );

  return reply.grants.map((grant) => grantSummary(grant, withOwner));
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- An untrusted HTTP body is parsed here.
export function brokerStatus(reply: unknown): BrokerStatus {
  const invalid = new CredentialBrokerError(
    "INVALID_RESPONSE",
    "Credential broker returned an invalid status",
  );

  if (
    !reply ||
    typeof reply !== "object" ||
    !("apiVersion" in reply && "role" in reply && "limits" in reply)
  )
    throw invalid;

  const { apiVersion, role, limits } = reply;
  const counts = "counts" in reply ? reply.counts : undefined;

  const maxTtl =
    limits && typeof limits === "object" && "maxGrantTtlSeconds" in limits
      ? limits.maxGrantTtlSeconds
      : undefined;

  if (
    typeof apiVersion !== "number" ||
    !Number.isSafeInteger(apiVersion) ||
    (role !== "admin" && role !== "issuer" && role !== "github-actions") ||
    typeof maxTtl !== "number" ||
    !Number.isSafeInteger(maxTtl)
  )
    throw invalid;

  const status = { apiVersion, role, limits: { maxGrantTtlSeconds: maxTtl } } as const;

  if (
    counts &&
    typeof counts === "object" &&
    "integrations" in counts &&
    "issuable" in counts &&
    "activeGrants" in counts &&
    typeof counts.integrations === "number" &&
    typeof counts.issuable === "number" &&
    typeof counts.activeGrants === "number"
  )
    return {
      ...status,
      counts: {
        integrations: counts.integrations,
        issuable: counts.issuable,
        activeGrants: counts.activeGrants,
      },
    };

  return status;
}
