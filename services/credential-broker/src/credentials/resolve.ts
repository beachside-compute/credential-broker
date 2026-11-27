import { brokerIntegration } from "../integrations/definitions";
import type { StoredIntegration } from "../integrations/types";
import type { EncryptionKeyring } from "./sources/encrypted-store";
import { encryptedStoreSource, openEndpointValues } from "./sources/encrypted-store";
import { workerSecretSource } from "./sources/worker-secret";
import type { WorkerSecretBindings } from "./sources/worker-secret";
import type { ResolvedCredential } from "./source";

export type UpstreamCredential = ResolvedCredential | { values: Record<string, string> };

export interface ResolutionContext {
  /** Only the operator's own deployment may read Worker secrets. */
  workerSecrets?: WorkerSecretBindings;
  keyring(): Promise<EncryptionKeyring>;
}

/** The upstream credential for an authorized request, or nothing when it cannot be used. */
export async function resolveCredential(
  integration: StoredIntegration,
  { workerSecrets, keyring }: ResolutionContext,
): Promise<UpstreamCredential | undefined> {
  const reference = integration.credential;
  const endpoint = brokerIntegration(integration.kind).family === "endpoint";

  switch (reference.source) {
    case "worker-secret":
      return workerSecrets && !endpoint
        ? workerSecretSource(workerSecrets).resolve(reference)
        : undefined;
    case "encrypted-store": {
      if (!endpoint) return encryptedStoreSource(integration, await keyring()).resolve(reference);

      const values = await openEndpointValues(reference, integration, await keyring());

      return values && { values };
    }
  }
}
