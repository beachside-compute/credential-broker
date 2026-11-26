import { z } from "zod";
import { resealDestination } from "../canaries/alerts";
import { integrationId } from "../config";
import { resealCredential } from "../credentials/sources/encrypted-store";
import type { Env } from "../http";
import { localKeyService } from "./data-key";
import type { PlatformActor } from "./directory-schema";
import { defaultTenant, tenantId } from "./identity";
import { auditOperation, operableTenant, PlatformError } from "./platform-operations";
import type { PlatformErrorRecord } from "./platform-operations";
import { invalidateTenantKeyring, tenantFor } from "./tenant";

const versionInput = z.string().regex(/^t[1-9]\d{0,8}$/);

export const rotationOptions = z.strictObject({ expectedKeyVersion: versionInput.optional() });

const rotateInput = rotationOptions.extend({ id: tenantId });

export type KeyRotationRequest = z.input<typeof rotateInput>;

const maxRotationBatches = 32;

function nextVersion(version: string): string | undefined {
  if (!versionInput.safeParse(version).success) return;

  return versionInput.safeParse(`t${Number(version.slice(1)) + 1}`).data;
}

export async function rotateTenantDataKey(
  env: Env,
  actor: PlatformActor,
  request: KeyRotationRequest,
) {
  const idInput = tenantId.safeParse(request?.id);

  if (!idInput.success || idInput.data === defaultTenant)
    throw new PlatformError(404, "tenant_not_found");

  const input = rotateInput.safeParse(request);

  if (!input.success) throw new PlatformError(400, "invalid_data_key_rotation");

  const { id, expectedKeyVersion } = input.data;

  return auditOperation(env, actor, id, "rotate_data_key", async () => {
    const store = await operableTenant(env, id);
    const state = await store.dataKeys();
    let active = state.active;
    const versions = state.keys.map(({ version }) => version);
    const previous = versions.find((version) => version !== active);

    if (
      !versionInput.safeParse(active).success ||
      !versions.includes(active) ||
      versions.length > 2 ||
      (previous && nextVersion(previous) !== active)
    )
      throw keyChanged();

    if (expectedKeyVersion !== undefined) {
      if (previous && previous !== expectedKeyVersion) throw keyChanged();

      if (!previous && expectedKeyVersion !== active) {
        if (nextVersion(expectedKeyVersion) !== active) throw keyChanged();

        return { id, keyVersion: active };
      }
    }

    if (!previous) {
      const next = nextVersion(active);

      if (!next) throw keyChanged();

      active = next;
      const wrapped = await localKeyService(env).generateDataKey({ tenant: id, version: active });

      if (!(await store.beginDataKeyRotation(state.active, active, wrapped))) throw keyChanged();
    }

    const keyring = await tenantFor(env, id).keyring();

    if (keyring.active !== active) throw keyChanged();

    for (let attempt = 0; attempt < maxRotationBatches; attempt++) {
      const batch = await store.dataKeyRotationBatch(active);

      if (!batch) throw keyChanged();

      if (!batch.credentials.length && !batch.destinations.length) break;

      let moved = 0;

      for (const integration of batch.credentials) {
        const { credential, identity } = integration;

        if (credential.source !== "encrypted-store") continue;

        const replacement = await resealCredential(credential, integration, keyring);

        if (!replacement) throw unreadableRecord("integration", integration.id);

        if (await store.changeCredentialEnvelope(identity, credential, replacement)) moved++;
      }

      for (const destination of batch.destinations) {
        const replacement = await resealDestination(destination, keyring);

        if (!replacement) throw unreadableRecord("alert_destination", destination.id);

        if (
          await store.changeDestinationEnvelope(
            destination.identity,
            destination.config,
            replacement,
          )
        )
          moved++;
      }

      if (!moved) break;
    }

    if (!(await store.finishDataKeyRotation(active))) throw keyChanged();
    invalidateTenantKeyring(env, id);

    return { id, keyVersion: active };
  });
}

function keyChanged(): PlatformError {
  return new PlatformError(409, "tenant_key_changed");
}

function unreadableRecord(kind: PlatformErrorRecord["kind"], id: string): PlatformError {
  const parsed = integrationId.safeParse(id);

  return new PlatformError(
    409,
    "tenant_ciphertext_unavailable",
    parsed.success ? { kind, id: parsed.data } : undefined,
  );
}
