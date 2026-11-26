import {
  matchingEndpointValues,
  normalizeEndpoint,
  normalizeEndpointValues,
} from "../../../../src/endpoint";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { integrationId, requestLimit, tenantConfigFor } from "../config";
import { credentialInput } from "../credentials/source";
import type { CredentialInput, CredentialReference } from "../credentials/source";
import {
  openEndpointValues,
  sealCredential,
  sealEndpointValues,
} from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import { workerSecretSource } from "../credentials/sources/worker-secret";
import { privateJson, privateNoContent, readJson } from "../http";
import type { Worker } from "../http";
import { failure } from "../proxy/forward";
import { grantView } from "../grants/view";
import { finishSpan, parseTraceparent, startSpan } from "../observability/tracing";
import type { AdminOperation } from "../observability/tracing";
import { integrationKind, maxIntegrations } from "./types";
import { canaryAdminRoutes, tripRoleKey } from "../canaries/admin";
import type { IntegrationRevision } from "./types";
import { defaultTenant } from "../tenants/identity";
import { resolveTenant } from "../tenants/resolve";
import { isBrokerHost } from "../tenants/hosts";
import type { Tenant } from "../tenants/tenant";

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
  const tenant = await resolveTenant(context);

  if (!tenant) return failure(401, "administrator_authentication_required");

  if (!(await tenant.administrator(context.req.raw))) {
    await tripRoleKey(context, tenant, "admin-auth");

    return failure(401, "administrator_authentication_required");
  }

  context.set("keyring", await tenant.keyring());
  await next();
});

adminRoutes.get("/integrations", traceAdmin("admin.integration.list"), async (context) => {
  const store = context.get("tenant").store;
  const issuable = new Set(await store.listIssuerIntegrations());
  const list = await store.listIntegrations();

  return privateJson({
    integrations: list.map((item) => ({ ...item, issuable: issuable.has(item.id) })),
  });
});

adminRoutes.get("/grants", traceAdmin("admin.grant.list"), async (context) => {
  const grants = await context.get("tenant").store.listGrants();

  return privateJson({ grants: grants.map((grant) => grantView(grant, true)) });
});

adminRoutes.get("/config", traceAdmin("admin.config.read"), async (context) => {
  const tenant = context.get("tenant");
  const config = await tenant.config();

  // Binding names stay private. The workflow trust policy is configuration, not a secret.
  const limits = config.limits ?? {};
  const known = await tenant.store.listIntegrations();
  const trustedIssuers = tenant.trustedIssuers().map(({ issuer, roles }) => ({ issuer, roles }));

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
    issuerKey: await tenant.hasIssuerKey(),
    ...(trustedIssuers.length && { trustedIssuers }),
  });
});

adminRoutes.put("/config", traceAdmin("admin.config.update"), async (context) => {
  const tenant = context.get("tenant");

  if (tenant.id === defaultTenant) return failure(409, "config_managed_by_deployment");

  const config = tenantConfigFor(tenant.id).safeParse(
    await readJson(context.req.raw, maxEndpointBody),
  );

  if (!config.success) return failure(400, "invalid_config");

  await tenant.store.setStoredConfig(config.data);

  return privateNoContent();
});

adminRoutes.post("/integrations", traceAdmin("admin.integration.create"), async (context) => {
  const input = createInput.safeParse(await readJson(context.req.raw, maxEndpointBody));

  if (!input.success) return failure(400, "invalid_integration");

  const tenant = context.get("tenant");

  if (tenant.id !== defaultTenant && input.data.credential.source === "worker-secret")
    return failure(400, "invalid_integration");

  const { id, kind } = input.data;
  const now = Date.now();
  const identity = crypto.randomUUID();
  const keyring = context.get("keyring");
  const endpoint = input.data.kind === "http" ? normalizeEndpoint(input.data.endpoint) : null;
  const revision = { identity, id, kind, endpoint: endpoint ?? null, credentialVersion: 1 };
  let credential: CredentialReference | undefined;

  if (input.data.kind === "http") {
    const values = normalizeEndpointValues(input.data.credential.values);

    if (
      !endpoint ||
      !values ||
      !matchingEndpointValues(endpoint, values, "full") ||
      (tenant.id !== defaultTenant &&
        isBrokerHost(context.env, context.req.url, new URL(endpoint.baseURL)))
    )
      return failure(400, "invalid_integration");

    credential = await sealEndpointValues(values, { ...revision, kind: "http", endpoint }, keyring);
  } else {
    credential = await prepareCredential(
      input.data.credential,
      revision,
      context.env,
      context.get("tenant"),
      keyring,
    );
  }

  if (!credential) return failure(503, "credential_unavailable");

  const result = await context.get("tenant").store.createIntegration({
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

  const store = context.get("tenant").store;
  const result = await store.getIntegration(id.data);

  if (!result) return failure(404, "integration_not_found");

  const issuable = (await store.listIssuerIntegrations()).includes(result.id);

  return privateJson({ ...result, issuable });
});

adminRoutes.patch("/integrations/:id", traceAdmin("admin.integration.update"), async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));
  const input = stateInput.safeParse(await readJson(context.req.raw, maxAdminBody));

  if (!id.success || !input.success) return failure(400, "invalid_integration");

  const result = await context
    .get("tenant")
    .store.setIntegrationEnabled(id.data, input.data.enabled);

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

    const tenant = context.get("tenant");

    if (
      tenant.id !== defaultTenant &&
      "source" in input.data &&
      input.data.source === "worker-secret"
    )
      return failure(400, "invalid_integration");

    const store = tenant.store;
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

      credential = await prepareCredential(
        input.data,
        next,
        context.env,
        context.get("tenant"),
        keyring,
      );
    }

    if (!credential) return failure(503, "credential_unavailable");

    const result = await store.rotateCredential(revision, credential);

    return result ? privateJson(result) : failure(409, "integration_changed");
  },
);

adminRoutes.delete("/integrations/:id", traceAdmin("admin.integration.delete"), async (context) => {
  const id = integrationId.safeParse(context.req.param("id"));

  if (!id.success) return failure(400, "invalid_integration_id");

  await context.get("tenant").store.deleteIntegration(id.data);

  return privateNoContent();
});

adminRoutes.get(
  "/issuer-permissions",
  traceAdmin("admin.issuer_permissions.read"),
  async (context) =>
    privateJson({ integrations: await context.get("tenant").store.listIssuerIntegrations() }),
);

adminRoutes.put(
  "/issuer-permissions",
  traceAdmin("admin.issuer_permissions.update"),
  async (context) => {
    const input = permissionsInput.safeParse(await readJson(context.req.raw, maxAdminBody));

    if (!input.success) return failure(400, "invalid_issuer_permissions");

    const integrations = await context
      .get("tenant")
      .store.setIssuerIntegrations(input.data.integrations);

    return integrations ? privateJson({ integrations }) : failure(404, "integration_not_found");
  },
);

adminRoutes.put(
  "/issuer-permissions/:id",
  traceAdmin("admin.issuer_permissions.update"),
  async (context) => {
    const id = integrationId.safeParse(context.req.param("id"));

    if (!id.success) return failure(400, "invalid_integration_id");

    const integrations = await context.get("tenant").store.allowIssuerIntegration(id.data);

    return integrations ? privateJson({ integrations }) : failure(404, "integration_not_found");
  },
);

adminRoutes.delete(
  "/issuer-permissions/:id",
  traceAdmin("admin.issuer_permissions.update"),
  async (context) => {
    const id = integrationId.safeParse(context.req.param("id"));

    if (!id.success) return failure(400, "invalid_integration_id");

    const integrations = await context.get("tenant").store.denyIssuerIntegration(id.data);

    return integrations ? privateJson({ integrations }) : failure(404, "integration_not_found");
  },
);

adminRoutes.route("/", canaryAdminRoutes);

function traceAdmin(operation: AdminOperation): MiddlewareHandler<AdminWorker> {
  return async (context, next) => {
    const span = startSpan(
      context.env,
      context.get("tenant").id,
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
  tenant: Tenant,
  keyring: EncryptionKeyring,
) {
  if (input.source === "encrypted-store") {
    return sealCredential(input.value, revision, keyring);
  }

  const config = await tenant.config();

  if (!config.workerSecretBindings.includes(input.binding)) return;

  return (await workerSecretSource(env).resolve(input)) ? input : undefined;
}
