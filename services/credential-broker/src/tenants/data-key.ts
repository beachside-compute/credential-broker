import { encryptionKeyring, openValue, sealValue } from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { EncryptedCredential } from "../credentials/source";
import type { Env } from "../http";
import { assertSeparateRoleKeys } from "./role-keys";

export function rootKeyring(env: Env): EncryptionKeyring {
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

export function wrapDataKey(key: string, id: string, root: EncryptionKeyring) {
  return sealValue(key, ["beachside-tenant-key/v1", id], root);
}

export async function unwrapDataKey(
  reference: EncryptedCredential,
  id: string,
  root: EncryptionKeyring,
) {
  const value = await openValue(reference, ["beachside-tenant-key/v1", id], root, 43);

  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error("Tenant encryption key unavailable");

  return value;
}
