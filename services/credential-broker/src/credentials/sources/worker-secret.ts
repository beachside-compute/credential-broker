import { credentialValue } from "../source";
import type { CredentialSource, WorkerSecretReference } from "../source";

export type WorkerSecretBindings = Partial<Record<WorkerSecretReference["binding"], string>>;

export function workerSecretSource(
  bindings: WorkerSecretBindings,
): CredentialSource<WorkerSecretReference> {
  return {
    async resolve(reference) {
      const parsed = credentialValue.safeParse(bindings[reference.binding]);

      return parsed.success ? { value: parsed.data } : undefined;
    },
  };
}
