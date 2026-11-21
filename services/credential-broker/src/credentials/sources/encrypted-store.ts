import { matchingEndpointValues, normalizeEndpointValues } from "../../../../../src/endpoint";
import { z } from "zod";
import type { HttpIntegrationRevision, IntegrationRevision } from "../../integrations/types";
import { credentialValue } from "../source";
import type { CredentialSource, EncryptedCredential } from "../source";

const keyVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);

const encodedKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const keyringSchema = z.record(keyVersion, encodedKey);

const encoder = new TextEncoder();

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface EncryptionBindings {
  BROKER_ENCRYPTION_KEYS?: string;
  BROKER_ENCRYPTION_KEY_VERSION?: string;
}

export interface EncryptionKeyring {
  active: string;
  keys: ReadonlyMap<string, string>;
}

export function encryptionKeyring(bindings: EncryptionBindings): EncryptionKeyring {
  const { BROKER_ENCRYPTION_KEYS, BROKER_ENCRYPTION_KEY_VERSION } = bindings;

  try {
    // Without a version binding, the first key version `bun run deploy:setup` creates is active.
    const active = keyVersion.parse(BROKER_ENCRYPTION_KEY_VERSION ?? "v1");

    const keys = new Map(
      Object.entries(keyringSchema.parse(JSON.parse(BROKER_ENCRYPTION_KEYS ?? ""))),
    );

    if (!keys.has(active) || keys.size > 8) throw new Error();

    for (const encoded of keys.values()) {
      const bytes = decode(encoded);

      if (bytes.length !== 32 || encode(bytes) !== encoded) throw new Error();
    }

    return { active, keys };
  } catch {
    throw new Error("Invalid broker encryption keyring configuration");
  }
}

export async function sealCredential(
  value: string,
  integration: IntegrationRevision,
  keyring: EncryptionKeyring,
): Promise<EncryptedCredential> {
  return seal(value, integration, keyring);
}

export function sealEndpointValues(
  values: Record<string, string>,
  integration: HttpIntegrationRevision,
  keyring: EncryptionKeyring,
): Promise<EncryptedCredential> {
  return seal(JSON.stringify(values), integration, keyring);
}

async function seal(
  value: string,
  integration: IntegrationRevision,
  keyring: EncryptionKeyring,
): Promise<EncryptedCredential> {
  const keyVersion = keyring.active;
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(integration, keyVersion), tagLength: 128 },
    await importKey(keyring, keyVersion, "encrypt"),
    encoder.encode(value),
  );

  return {
    source: "encrypted-store",
    keyVersion,
    nonce: encode(nonce),
    ciphertext: encode(new Uint8Array(ciphertext)),
  };
}

export function encryptedStoreSource(
  integration: IntegrationRevision,
  keyring: EncryptionKeyring,
): CredentialSource<EncryptedCredential> {
  return {
    async resolve(reference) {
      const plaintext = await open(reference, integration, keyring, 4096);
      const result = credentialValue.safeParse(plaintext);

      return result.success ? { value: result.data } : undefined;
    },
  };
}

export async function openEndpointValues(
  reference: EncryptedCredential,
  integration: IntegrationRevision,
  keyring: EncryptionKeyring,
): Promise<Record<string, string> | undefined> {
  const { endpoint } = integration;

  if (!endpoint) return;

  const json = await open(reference, integration, keyring, 67_000);

  if (json === undefined) return;

  try {
    const values = normalizeEndpointValues(JSON.parse(json));

    return values && matchingEndpointValues(endpoint, values, "full") ? values : undefined;
  } catch {
    return;
  }
}

async function open(
  reference: EncryptedCredential,
  integration: IntegrationRevision,
  keyring: EncryptionKeyring,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    if (reference.ciphertext.length > Math.ceil(((maxBytes + 16) * 4) / 3)) return;

    const nonce = decode(reference.nonce);
    const ciphertext = decode(reference.ciphertext);

    if (nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > maxBytes + 16) return;

    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad(integration, reference.keyVersion),
        tagLength: 128,
      },
      await importKey(keyring, reference.keyVersion, "decrypt"),
      ciphertext,
    );

    return decoder.decode(plaintext);
  } catch {
    return;
  }
}

function aad(integration: IntegrationRevision, keyVersion: string) {
  return encoder.encode(
    JSON.stringify([
      "beachside-credential/v1",
      integration.identity,
      integration.id,
      integration.kind,
      integration.credentialVersion,
      keyVersion,
      ...(integration.kind === "http" ? [integration.endpoint] : []),
    ]),
  );
}

async function importKey(
  keyring: EncryptionKeyring,
  version: string,
  usage: "encrypt" | "decrypt",
) {
  const encoded = keyring.keys.get(version);

  if (!encoded) throw new Error("Encryption key unavailable");

  return crypto.subtle.importKey("raw", decode(encoded), { name: "AES-GCM" }, false, [usage]);
}

function encode(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < bytes.length; index++) bytes[index] = decoded.charCodeAt(index);

  return bytes;
}
