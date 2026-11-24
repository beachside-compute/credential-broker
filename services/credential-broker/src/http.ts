import { assertSeparateRoleKeys } from "./auth";
import type { RoleBindings } from "./auth";
import { encryptionKeyring } from "./credentials/sources/encrypted-store";
import type { EncryptionBindings } from "./credentials/sources/encrypted-store";
import type { WorkerSecretBindings } from "./credentials/sources/worker-secret";
import type { GrantRegistry } from "./grants/registry";
import type { TraceExportBindings } from "./observability/otlp";

interface Env extends TraceExportBindings, WorkerSecretBindings, RoleBindings, EncryptionBindings {
  BROKER_CONFIG?: string;
  /** Present only when the deployment sets BROKER_EMAIL_FROM. */
  EMAIL?: SendEmail;
  BROKER_EMAIL_FROM?: string;
  REGISTRY: DurableObjectNamespace<GrantRegistry>;
}

export type Worker = { Bindings: Env };

export function registry(env: Env) {
  return env.REGISTRY.getByName("grant-registry");
}

export function managementKeyring(env: Env) {
  const keyring = encryptionKeyring(env);
  assertSeparateRoleKeys(env, keyring.keys.values());

  return keyring;
}

export function privateJson<Value>(value: Value, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function privateNoContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function readJson(request: Request, maxBytes: number) {
  if (!request.headers.get("content-type")?.match(/^application\/json(?:;|$)/i)) return;
  const reader = request.body?.getReader();

  if (!reader) return;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;

      if (size > maxBytes) {
        await reader.cancel();

        return;
      }

      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Malformed UTF-8 and JSON share the same client-facing error.
  } finally {
    reader.releaseLock();
  }
}
