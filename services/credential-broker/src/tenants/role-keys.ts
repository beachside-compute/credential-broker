export interface RoleBindings {
  BROKER_ADMIN_KEY?: string;
  BROKER_ISSUER_KEY?: string;
}

export function assertSeparateRoleKeys(
  bindings: RoleBindings,
  encryptionKeys: Iterable<string>,
): void {
  const { BROKER_ADMIN_KEY: admin, BROKER_ISSUER_KEY: issuer } = bindings;

  if (admin && admin === issuer)
    throw new Error("Broker administration and issuance keys must differ");

  for (const key of encryptionKeys) {
    if (key === admin || key === issuer)
      throw new Error("Broker role keys must differ from encryption keys");
  }
}
