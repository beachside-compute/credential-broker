import { z } from "zod";
import { brokerIntegration } from "./integrations/definitions";
import type { IntegrationKind } from "./integrations/types";
import { tenantId, tenantRole } from "./tenants/identity";

export const integrationId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** Seven days, long enough for an always-on sandbox between renewals (with a static issuer key; a GitHub Actions run can only renew its own grants). */
export const maxGrantTtlSeconds = 604_800;

/** Printable ASCII without leading or trailing space, shown in grant listings. */
export const grantLabel = z.string().regex(/^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/);

/** Feature level of the broker HTTP API, reported by `GET /v1/status`. */
export const apiVersion = 2;

export const workerSecretBinding = z.templateLiteral([
  "CREDENTIAL_",
  z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
]);

const id = z.string().regex(/^[1-9][0-9]{0,19}$/);

const workflowPolicy = z
  .strictObject({
    repositoryId: id,
    repositoryOwnerId: id,
    repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
    ref: z
      .string()
      .regex(/^refs\/(heads|tags)\/[^\s*?[\]]+$/)
      .max(512),
    workflowRef: z.string().min(1).max(512),
    jobWorkflowRef: z.string().min(1).max(512).optional(),
    event: z.enum(["push", "schedule", "workflow_dispatch", "workflow_run", "pull_request_target"]),
    integrations: z.array(integrationId).min(1).max(16),
  })
  .superRefine((value, ctx) => {
    const prefix = `${value.repository}/.github/workflows/`;

    if (!value.workflowRef.startsWith(prefix) || !value.workflowRef.endsWith(`@${value.ref}`)) {
      ctx.addIssue({
        code: "custom",
        message: "workflowRef must identify the configured repository and ref",
      });
    }
  });

const limitOverride = z.strictObject({
  requestsPerMinute: z.int().min(1).max(100_000).optional(),
  concurrentRequests: z.int().min(1).max(1_000).optional(),
});

export type RequestLimits = Record<string, z.infer<typeof limitOverride>>;

export function requestLimit(
  integration: { id: string; kind: IntegrationKind },
  limits: RequestLimits,
) {
  return {
    ...brokerIntegration(integration.kind).limit,
    ...(Object.hasOwn(limits, integration.id) && limits[integration.id]),
  };
}

const tenantConfiguration = z.strictObject({
  limits: z
    .record(integrationId, limitOverride)
    .refine((limits) => Object.keys(limits).length <= 100)
    .optional(),
  githubActions: z
    .strictObject({
      audience: z.string().min(1).max(256),
      workflows: z.array(workflowPolicy).min(1).max(32),
    })
    .optional(),
});

export type TenantConfig = z.infer<typeof tenantConfiguration>;

export function tenantConfigFor(id: string) {
  return tenantConfiguration.refine(
    (config) => !config.githubActions || config.githubActions.audience === `beachside-broker:${id}`,
  );
}

const httpsURL = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);

    return Boolean(url && !url.username && !url.password && !url.hash);
  });

const trustedIssuer = z.strictObject({
  issuer: httpsURL,
  jwksUri: httpsURL,
  audience: z.string().min(1).max(256),
  roles: z
    .array(tenantRole)
    .min(1)
    .max(2)
    .refine((roles) => new Set(roles).size === roles.length)
    .default(["issuer"]),
  tenant: tenantId.optional(),
});

export type TrustedIssuer = z.infer<typeof trustedIssuer>;

const configuration = tenantConfiguration.extend({
  workerSecretBindings: z.array(workerSecretBinding).max(100).default([]),
  trustedIssuers: z
    .array(trustedIssuer)
    .max(4)
    .refine((entries) => new Set(entries.map((entry) => entry.issuer)).size === entries.length)
    .optional(),
});

export type BrokerConfig = z.infer<typeof configuration>;

let cachedConfig: { raw: string; hosted: boolean; config: BrokerConfig } | undefined;

export class HostedIssuerConfigurationError extends Error {
  constructor() {
    super("Unpinned trusted issuers require BROKER_TENANT_DOMAIN");
  }
}

export function parseConfig(raw: string, hosted = false): BrokerConfig {
  if (cachedConfig?.raw === raw && cachedConfig.hosted === hosted) return cachedConfig.config;

  const result = configuration.safeParse(JSON.parse(raw));

  if (!result.success) throw new Error("Invalid broker configuration");

  if (!hosted && result.data.trustedIssuers?.some(({ tenant }) => !tenant))
    throw new HostedIssuerConfigurationError();

  cachedConfig = { raw, hosted, config: result.data };

  return result.data;
}
