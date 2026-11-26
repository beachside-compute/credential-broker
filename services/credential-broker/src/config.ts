import { z } from "zod";
import type { IntegrationKind } from "./integrations/types";

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

/** Per grant and integration. Git clones and fetches burst far more than model calls. */
const defaultLimits: Record<
  IntegrationKind,
  { requestsPerMinute: number; concurrentRequests: number }
> = {
  github: { requestsPerMinute: 800, concurrentRequests: 32 },
  anthropic: { requestsPerMinute: 600, concurrentRequests: 32 },
  openai: { requestsPerMinute: 600, concurrentRequests: 32 },
  openrouter: { requestsPerMinute: 600, concurrentRequests: 32 },
  http: { requestsPerMinute: 300, concurrentRequests: 8 },
};

export function requestLimit(
  integration: { id: string; kind: IntegrationKind },
  limits: RequestLimits,
) {
  return {
    ...defaultLimits[integration.kind],
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

const configuration = tenantConfiguration.extend({
  workerSecretBindings: z.array(workerSecretBinding).max(100).default([]),
});

export type BrokerConfig = z.infer<typeof configuration>;

let cachedConfig: { raw: string; config: BrokerConfig } | undefined;

export function parseConfig(raw: string): BrokerConfig {
  if (cachedConfig?.raw === raw) return cachedConfig.config;

  const result = configuration.safeParse(JSON.parse(raw));

  if (!result.success) throw new Error("Invalid broker configuration");

  cachedConfig = { raw, config: result.data };

  return result.data;
}
