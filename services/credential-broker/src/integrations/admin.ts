import {
  matchingEndpointValues,
  normalizeEndpoint,
  normalizeEndpointValues,
} from "../../../../src/endpoint";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { administrator } from "../auth";
import { integrationId, parseConfig, requestLimit } from "../config";
import { credentialInput } from "../credentials/source";
import type { CredentialInput, CredentialReference } from "../credentials/source";
import {
  openEndpointValues,
  sealCredential,
  sealEndpointValues,
} from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import { workerSecretSource } from "../credentials/sources/worker-secret";
import { managementKeyring, privateJson, privateNoContent, readJson, registry } from "../http";
import type { Worker } from "../http";
import { failure } from "../proxy/forward";
import { grantView } from "../grants/view";
import { finishSpan, parseTraceparent, startSpan } from "../observability/tracing";
import type { AdminOperation } from "../observability/tracing";
import { integrationKind, maxIntegrations } from "./types";
import { canaryAdminRoutes, tripRoleKey } from "../canaries/admin";
import type { IntegrationRevision } from "./types";

const maxAdminBody = 16_384;

const maxEndpointBody = 96_000;

const endpointCredential = z.strictObject({
  source: z.literal("encrypted-store"),
  values: z.unknown(),
});

const createInput = z.union([
  z.strictObject({
    id: integrationId,
    kind: integrationKind.exclude(["http"]),
    credential: credentialInput,
  }),
  z.strictObject({
    id: integrationId,
    kind: z.literal("http"),
    endpoint: z.unknown(),
    credential: endpointCredential,
  }),
]);

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
    await tripRoleKey(context, "admin-auth");

    return failure(401, "administrator_authentication_required");
  }

  context.set("keyring", managementKeyring(context.env));
  await next();
});

adminRoutes.get("/integrations", traceAdmin("admin.integration.list"), async (context) => {
  const store = registry(context.env);
  const issuable = new Set(await store.listIssuerIntegrations());
  const list = await store.listIntegrations();

  return privateJson({
    integrations: list.map((item) => ({ ...item, issuable: issuable.has(item.id) })),
  });
});

adminRoutes.get("/grants", traceAdmin("admin.grant.list"), async (context) => {
  const grants = await registry(context.env).listGrants();

  return privateJson({ grants: grants.map((grant) => grantView(grant, true)) });
});

adminRoutes.get("/config", traceAdmin("admin.config.read"), async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");

  // Binding names stay private. The workflow trust policy is configuration, not a secret.
  const limits = config.limits ?? {};
  const known = await registry(context.env).listIntegrations();

  return privateJson({
    githubActions: config.githubActions ?? null,
    limits: Object.fromEntries(
      known.map((integration) => [
        integration.id,
        { ...requestLimit(integration, limits), configured: Object.hasOwn(limits, integration.id) },
      ]),
    ),
    unknownLimitIds: Object.keys(limits).filter((id) => !known.some((row) => row.id === id)),
    workerSecretBindings: config.workerSecretBindings.length,
    issuerKey: Boolean(context.env.BROKER_ISSUER_KEY),
  });
});

adminRoutes.post("/integrations", traceAdmin("admin.integration.create"), async (context) => {
  const input = createInput.safeParse(await readJson(context.req.raw, maxEndpointBody));

  if (!input.success) return failure(400, "invalid_integration");

  const { id, kind } = input.data;
  const now = Date.now();
  const identity = crypto.randomUUID();
  const keyring = context.get("keyring");
  const endpoint = input.data.kind === "http" ? normalizeEndpoint(input.data.endpoint) : null;
  const revision = { identity, id, kind, endpoint: endpoint ?? null, credentialVersion: 1 };
  let credential: CredentialReference | undefined;

  if (input.data.kind === "http") {
    const values = normalizeEndpointValues(input.data.credential.values);

    if (!endpoint || !values || !matchingEndpointValues(endpoint, values, "full"))
      return failure(400, "invalid_integration");

    credential = await sealEndpointValues(values, { ...revision, kind: "http", endpoint }, keyring);
  } else {
    credential = await prepareCredential(input.data.credential, revision, context.env, keyring);
  }

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

  const store = registry(context.env);
  const result = await store.getIntegration(id.data);

  if (!result) return failure(404, "integration_not_found");

  const issuable = (await store.listIssuerIntegrations()).includes(result.id);

  return privateJson({ ...result, issuable });
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

    const input = z
      .union([credentialInput, endpointCredential])
      .safeParse(await readJson(context.req.raw, maxEndpointBody));

    if (!id.success || !input.success) return failure(400, "invalid_credential");

    const store = registry(context.env);
    const revision = await store.credentialRevision(id.data);

    if (!revision) return failure(404, "integration_not_found");

    const next = { ...revision, credentialVersion: revision.credentialVersion + 1 };
    const keyring = context.get("keyring");
    let credential: CredentialReference | undefined;

    if (revision.kind === "http") {
      const { endpoint, credential: previous } = revision;
      const values = "values" in input.data && normalizeEndpointValues(input.data.values);

      if (!endpoint || !values || !matchingEndpointValues(endpoint, values, "partial"))
        return failure(400, "invalid_credential");

      const nextEndpoint = { ...next, kind: revision.kind, endpoint };

      if (matchingEndpointValues(endpoint, values, "full")) {
        credential = await sealEndpointValues(values, nextEndpoint, keyring);
      } else {
        const current =
          previous.source === "encrypted-store" &&
          (await openEndpointValues(previous, revision, keyring));

        if (current)
          credential = await sealEndpointValues({ ...current, ...values }, nextEndpoint, keyring);
      }
    } else {
      if ("values" in input.data) return failure(400, "invalid_credential");

      credential = await prepareCredential(input.data, next, context.env, keyring);
    }

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

adminRoutes.put(
  "/issuer-permissions/:id",
  traceAdmin("admin.issuer_permissions.update"),
  async (context) => {
    const id = integrationId.safeParse(context.req.param("id"));

    if (!id.success) return failure(400, "invalid_integration_id");

    const integrations = await registry(context.env).allowIssuerIntegration(id.data);

    return integrations ? privateJson({ integrations }) : failure(404, "integration_not_found");
  },
);

adminRoutes.delete(
  "/issuer-permissions/:id",
  traceAdmin("admin.issuer_permissions.update"),
  async (context) => {
    const id = integrationId.safeParse(context.req.param("id"));

    if (!id.success) return failure(400, "invalid_integration_id");

    const integrations = await registry(context.env).denyIssuerIntegration(id.data);

    return integrations ? privateJson({ integrations }) : failure(404, "integration_not_found");
  },
);

adminRoutes.route("/", canaryAdminRoutes);

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
