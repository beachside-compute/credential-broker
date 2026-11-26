import type { TenantRole } from "./identity";

export interface RoleBindings {
  BROKER_ADMIN_KEY?: string;
  BROKER_ISSUER_KEY?: string;
  BROKER_PLATFORM_KEY?: string;
}

export function assertSeparateRoleKeys(
  bindings: RoleBindings,
  encryptionKeys: Iterable<string>,
): void {
  const {
    BROKER_ADMIN_KEY: admin,
    BROKER_ISSUER_KEY: issuer,
    BROKER_PLATFORM_KEY: platform,
  } = bindings;

  if (admin && admin === issuer)
    throw new Error("Broker administration and issuance keys must differ");

  if (platform && (platform === admin || platform === issuer))
    throw new Error("Broker platform key must differ from administration and issuance keys");

  for (const key of encryptionKeys) {
    if (key === admin || key === issuer || key === platform)
      throw new Error("Broker role keys must differ from encryption keys");
  }
}

const rolePrefixes = { admin: "bsa_", issuer: "bsi_" } as const;

export function newRoleKey(role: TenantRole): string {
  return (
    rolePrefixes[role] +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function matchesRoleFormat(role: TenantRole, key: string): boolean {
  return key.startsWith(rolePrefixes[role]) && /^[a-f0-9]{64}$/.test(key.slice(4));
}
