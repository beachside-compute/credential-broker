import type { GrantSummary } from "./registry";

/** The public form of a grant row. The owner is shown to administrators only. */
export function grantView(grant: GrantSummary, withOwner: boolean) {
  return {
    id: grant.id,
    integrations: grant.integrations,
    label: grant.label,
    createdAt: grant.createdAt ? new Date(grant.createdAt).toISOString() : null,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    requests: grant.requests,
    lastUsedAt: grant.lastUsedAt === null ? null : new Date(grant.lastUsedAt).toISOString(),
    ...(withOwner && { owner: grant.owner }),
  };
}
