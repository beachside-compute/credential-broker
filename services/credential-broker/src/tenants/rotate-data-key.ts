import { z } from "zod";
import { resealDestination } from "../canaries/alerts";
import { resealCredential } from "../credentials/sources/encrypted-store";
import type { Env } from "../http";
import { newDataKey, rootKeyring, wrapDataKey } from "./data-key";
import type { PlatformActor } from "./directory-schema";
import { tenantId } from "./identity";
import { auditOperation, operableTenant, PlatformError } from "./platform-operations";
import { invalidateTenantKeyring, tenantFor } from "./tenant";

const rotateInput = z.strictObject({ id: tenantId });

export async function rotateTenantDataKey(
  env: Env,
  actor: PlatformActor,
  request: z.input<typeof rotateInput>,
) {
  const input = rotateInput.safeParse(request);

  if (!input.success) throw new PlatformError(404, "tenant_not_found");

  const { id } = input.data;

  return auditOperation(env, actor, id, "rotate_data_key", async () => {
    const store = await operableTenant(env, id);
    const state = await store.dataKeys();
    let active = state.active;

    if (state.keys.length === 1) {
      active = `t${Number(state.active.slice(1)) + 1}`;
      const wrapped = await wrapDataKey(newDataKey(), id, rootKeyring(env), active);

      if (!(await store.beginDataKeyRotation(state.active, active, wrapped))) throw keyChanged();
    }

    const keyring = await tenantFor(env, id).keyring();

    if (keyring.active !== active || !state.keys.every(({ version }) => keyring.keys.has(version)))
      throw keyChanged();

    for (;;) {
      const batch = await store.dataKeyRotationBatch(active);

      if (!batch) throw keyChanged();

      if (!batch.credentials.length && !batch.destinations.length) break;

      for (const integration of batch.credentials) {
        const { credential, identity } = integration;

        if (credential.source !== "encrypted-store") continue;

        const replacement = await resealCredential(credential, integration, keyring);

        if (!replacement) throw new PlatformError(409, "tenant_ciphertext_unavailable");
        await store.changeCredentialEnvelope(identity, credential, replacement);
      }

      for (const destination of batch.destinations) {
        const replacement = await resealDestination(destination, keyring);

        if (!replacement) throw new PlatformError(409, "tenant_ciphertext_unavailable");
        await store.changeDestinationEnvelope(
          destination.identity,
          destination.config,
          replacement,
        );
      }
    }

    if (!(await store.finishDataKeyRotation(active))) throw keyChanged();
    invalidateTenantKeyring(env, id);

    return { id, keyVersion: active };
  });
}

function keyChanged(): PlatformError {
  return new PlatformError(409, "tenant_key_changed");
}
