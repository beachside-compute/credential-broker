import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { administrator } from "../auth";
import { integrationId, parseConfig } from "../config";
import { credentialInput } from "../credentials/source";
import type { CredentialInput } from "../credentials/source";
import { sealCredential } from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import { workerSecretSource } from "../credentials/sources/worker-secret";
import { managementKeyring, privateJson, privateNoContent, readJson, registry } from "../http";
import type { Worker } from "../http";
import { failure } from "../proxy/forward";
import { finishSpan, parseTraceparent, startSpan } from "../observability/tracing";
import type { AdminOperation } from "../observability/tracing";
import { integrationKind, maxIntegrations } from "./types";
import type { IntegrationRevision } from "./types";

const maxAdminBody = 16_384;

const createInput = z.strictObject({
  id: integrationId,
  kind: integrationKind,
  credential: credentialInput,
});

const stateInput = z.strictObject({ enabled: z.boolean() });

const permissionsInput = z.strictObject({
  integrations: z
    .array(integrationId)
    .max(maxIntegrations)
    .refine((ids) => new Set(ids).size === ids.length),
});

type AdminWorker = Worker & { Variables: { keyring: EncryptionKeyring } };

export const adminRoutes = new Hono<AdminWorker>();

adminRoutes.use("*", async (context, next) => {
  if (!(await administrator(context.req.raw, context.env.BROKER_ADMIN_KEY))) {
    return failure(401, "administrator_authentication_required");
  }

  context.set("keyring", managementKeyring(context.env));
  await next();
});

adminRoutes.get("/integrations", traceAdmin("admin.integration.list"), async (context) =>
  privateJson({ integrations: await registry(context.env).listIntegrations() }),
);

adminRoutes.post("/integrations", traceAdmin("admin.integration.create"), async (context) => {
  const input = createInput.safeParse(await readJson(context.req.raw, maxAdminBody));

  if (!input.success) return failure(400, "invalid_integration");

  const { id, kind } = input.data;
  const now = Date.now();
  const revision = { identity: crypto.randomUUID(), id, kind, credentialVersion: 1 };

  const credential = await prepareCredential(
    input.data.credential,
    revision,
    context.env,
    context.get("keyring"),
  );

  if (!credential) return failure(503, "credential_unavailable");

  const result = await registry(context.env).createIntegration({
    ...revision,
    credential,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  if (result === "exists") return failure(409, "integration_exists");

  if (result === "limit") return failure(429, "integration_limit");

  return privateJson(result, 201);
});

adminRoutes.get("/integrations/:id", traceAdmin("admin.integration.read"), async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));

  if (!id.success) return failure(400, "invalid_integration_id");

  const result = await registry(context.env).getIntegration(id.data);

  return result ? privateJson(result) : failure(404, "integration_not_found");
});

adminRoutes.patch("/integrations/:id", traceAdmin("admin.integration.update"), async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));
  const input = stateInput.safeParse(await readJson(context.req.raw, maxAdminBody));

  if (!id.success || !input.success) return failure(400, "invalid_integration");

  const result = await registry(context.env).setIntegrationEnabled(id.data, input.data.enabled);

  return result ? privateJson(result) : failure(404, "integration_not_found");
});

adminRoutes.put(
  "/integrations/:id/credential",
  traceAdmin("admin.integration.rotate"),
  async (context) => {
    const id = integrationId.safeParse(context.req.param("id"));
    const input = credentialInput.safeParse(await readJson(context.req.raw, maxAdminBody));

    if (!id.success || !input.success) return failure(400, "invalid_credential");

    const store = registry(context.env);
    const revision = await store.credentialRevision(id.data);

    if (!revision) return failure(404, "integration_not_found");

    const credential = await prepareCredential(
      input.data,
      { ...revision, credentialVersion: revision.credentialVersion + 1 },
      context.env,
      context.get("keyring"),
    );

    if (!credential) return failure(503, "credential_unavailable");

    const result = await store.rotateCredential(revision, credential);

    return result ? privateJson(result) : failure(409, "integration_changed");
  },
);

adminRoutes.delete("/integrations/:id", traceAdmin("admin.integration.delete"), async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));

  if (!id.success) return failure(400, "invalid_integration_id");

  await registry(context.env).deleteIntegration(id.data);

  return privateNoContent();
});

adminRoutes.get(
  "/issuer-permissions",
  traceAdmin("admin.issuer_permissions.read"),
  async (context) =>
    privateJson({ integrations: await registry(context.env).listIssuerIntegrations() }),
);

adminRoutes.put(
  "/issuer-permissions",
  traceAdmin("admin.issuer_permissions.update"),
  async (context) => {
    const input = permissionsInput.safeParse(await readJson(context.req.raw, maxAdminBody));

    if (!input.success) return failure(400, "invalid_issuer_permissions");

    const integrations = await registry(context.env).setIssuerIntegrations(input.data.integrations);

    return integrations ? privateJson({ integrations }) : failure(404, "integration_not_found");
  },
);

function traceAdmin(operation: AdminOperation): MiddlewareHandler<AdminWorker> {
  return async (context, next) => {
    const span = startSpan(
      context.env,
      (work) => context.executionCtx.waitUntil(work),
      operation,
      parseTraceparent(context.req.raw.headers.get("traceparent")),
    );

    try {
      await next();
    } finally {
      finishSpan(span, context.error ? 503 : context.res.status);
    }
  };
}

async function prepareCredential(
  input: CredentialInput,
  revision: IntegrationRevision,
  env: Worker["Bindings"],
  keyring: EncryptionKeyring,
) {
  if (input.source === "encrypted-store") {
    return sealCredential(input.value, revision, keyring);
  }

  const config = parseConfig(env.BROKER_CONFIG ?? "{}");

  if (!config.workerSecretBindings.includes(input.binding)) return;

  return (await workerSecretSource(env).resolve(input)) ? input : undefined;
}
