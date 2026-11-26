import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { z } from "zod";
import type { Principal } from ".";
import { integrationId } from "../config";
import type { TrustedIssuer } from "../config";
import { defaultTenant, tenantId, tenantRole } from "../tenants/identity";
import type { TenantRole } from "../tenants/identity";

const claims = z.object({
  sub: z.string().regex(/^[\x20-\x7e]{1,128}$/),
  tenant: tenantId,
  role: tenantRole,
  integrations: z.array(integrationId).max(100).optional(),
});

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function issuerKeys(entry: TrustedIssuer) {
  const id = JSON.stringify([entry.issuer, entry.jwksUri]);
  const cached = keysets.get(id);

  if (cached) return cached;

  const keys = createRemoteJWKSet(new URL(entry.jwksUri));

  if (keysets.size >= 16) keysets.delete(keysets.keys().next().value!);
  keysets.set(id, keys);

  return keys;
}

export async function trustedPrincipal(
  token: string,
  entries: readonly TrustedIssuer[],
  tenant: string,
  role: TenantRole,
): Promise<Principal | undefined> {
  if (entries.length === 0 || token.split(".").length !== 3) return;

  try {
    const hint = decodeJwt(token);
    const entry = entries.find((candidate) => candidate.issuer === hint.iss);

    if (!entry || !entry.roles.includes(role)) return;

    const expectedTenant = tenant === defaultTenant ? entry.tenant : tenant;

    if (
      !expectedTenant ||
      hint.tenant !== expectedTenant ||
      hint.role !== role ||
      hint.aud !== entry.audience
    )
      return;

    const { payload } = await jwtVerify(token, issuerKeys(entry), {
      issuer: entry.issuer,
      audience: entry.audience,
      algorithms: ["ES256"],
      requiredClaims: ["iss", "aud", "sub", "iat", "exp", "tenant", "role"],
      maxTokenAge: 600,
    });

    const result = claims.safeParse(payload);

    if (
      !result.success ||
      result.data.tenant !== expectedTenant ||
      result.data.role !== role ||
      payload.aud !== entry.audience
    )
      return;

    return { owner: `trusted:${result.data.sub}`, integrations: result.data.integrations };
  } catch {
    return;
  }
}
