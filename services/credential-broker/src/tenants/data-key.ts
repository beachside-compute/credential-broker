import {
  encryptionKeyring,
  importDataKey,
  openValue,
  sealValue,
} from "../credentials/sources/encrypted-store";
import type { EncryptionBindings, EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { EncryptedCredential } from "../credentials/source";
import { initialTenantKeyVersion } from "./identity";
import { assertSeparateRoleKeys } from "./role-keys";
import type { RoleBindings } from "./role-keys";

/** Binds a wrapped data key to one tenant and key version. */
export interface DataKeyContext {
  tenant: string;
  version: string;
}

/**
 * Root custody for hosted tenant data keys. The broker encrypts credentials with the data keys
 * itself; a backend only ever generates, opens and re-wraps the 32-byte keys.
 */
export interface KeyService {
  /** A new data key, returned only in wrapped form. */
  generateDataKey(context: DataKeyContext): Promise<EncryptedCredential>;
  /** Throws when the wrapped key does not open under `context`. */
  unwrapDataKey(wrapped: EncryptedCredential, context: DataKeyContext): Promise<CryptoKey>;
  /** The same data key under the active root, or nothing when it is already there. */
  rewrapDataKey(
    wrapped: EncryptedCredential,
    context: DataKeyContext,
  ): Promise<EncryptedCredential | undefined>;
}

export function rootKeyring(
  bindings: EncryptionBindings & RoleBindings,
): EncryptionKeyring<string> {
  const keyring = encryptionKeyring(bindings);
  assertSeparateRoleKeys(bindings, keyring.keys.values());

  return keyring;
}

/** Wraps data keys with the deployment root keyring held in this Worker's secrets. */
export function localKeyService(bindings: EncryptionBindings & RoleBindings): KeyService {
  const root = rootKeyring(bindings);

  const open = async (wrapped: EncryptedCredential, context: DataKeyContext) => {
    const key = await openValue(wrapped, sealContext(context), root, 43);

    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key))
      throw new Error("Tenant encryption key unavailable");

    return key;
  };

  return {
    generateDataKey: (context) => sealValue(newDataKey(), sealContext(context), root),
    unwrapDataKey: async (wrapped, context) => importDataKey(await open(wrapped, context)),
    async rewrapDataKey(wrapped, context) {
      if (wrapped.keyVersion === root.active) return;

      return sealValue(await open(wrapped, context), sealContext(context), root);
    },
  };
}

function newDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sealContext({ tenant, version }: DataKeyContext) {
  return version === initialTenantKeyVersion
    ? ["beachside-tenant-key/v1", tenant]
    : ["beachside-tenant-key/v2", tenant, version];
}
