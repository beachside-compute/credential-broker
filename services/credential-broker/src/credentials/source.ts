import { z } from "zod";
import { workerSecretBinding } from "../config";

export const credentialValue = z.string().regex(/^[\x21-\x7e]{1,4096}$/);

const workerSecretReference = z.strictObject({
  source: z.literal("worker-secret"),
  binding: workerSecretBinding,
});

export const credentialInput = z.discriminatedUnion("source", [
  workerSecretReference,
  z.strictObject({ source: z.literal("encrypted-store"), value: credentialValue }),
]);

export type CredentialInput = z.infer<typeof credentialInput>;

export type WorkerSecretReference = z.infer<typeof workerSecretReference>;

export interface EncryptedCredential {
  source: "encrypted-store";
  keyVersion: string;
  nonce: string;
  ciphertext: string;
}

export type CredentialReference = WorkerSecretReference | EncryptedCredential;

export interface ResolvedCredential {
  value: string;
  expiresAt?: number;
}

export interface CredentialSource<Reference> {
  resolve(reference: Reference): Promise<ResolvedCredential | undefined>;
}
