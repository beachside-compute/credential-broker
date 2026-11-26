import { encryptionKeyring, openValue, sealValue } from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { EncryptedCredential } from "../credentials/source";
import type { Env } from "../http";
import { initialTenantKeyVersion } from "./identity";
import { assertSeparateRoleKeys } from "./role-keys";

export function rootKeyring(env: Env): EncryptionKeyring<string> {
  const keyring = encryptionKeyring(env);
  assertSeparateRoleKeys(env, keyring.keys.values());

  return keyring;
}

export function newDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function dataKeyContext(id: string, version: string) {
  return version === initialTenantKeyVersion
    ? ["beachside-tenant-key/v1", id]
    : ["beachside-tenant-key/v2", id, version];
}

export function wrapDataKey(key: string, id: string, root: EncryptionKeyring, version: string) {
  return sealValue(key, dataKeyContext(id, version), root);
}

export async function unwrapDataKey(
  reference: EncryptedCredential,
  id: string,
  root: EncryptionKeyring,
  version: string,
) {
  const value = await openValue(reference, dataKeyContext(id, version), root, 43);

  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error("Tenant encryption key unavailable");

  return value;
}
