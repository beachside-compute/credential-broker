/* oxlint-disable anti-slop/no-runtime-typeof -- Validate broker responses and credentials at the HTTP trust boundary. */

import {
  assertStatus,
  bearerToken,
  brokerFailure,
  maxGrantTtlSeconds,
  refusalMessage,
  brokerOrigin,
  CredentialBrokerError,
  defaultFetch,
  fetchRequest,
  gatewayBaseURL,
  httpsURL,
  integrationName,
  jsonRecord,
  requireApiKey,
  sandboxToken,
  traceParentPattern,
  waitForSignal,
  withRequestSignal,
  type Fetch,
  type BrokerRequestOptions,
} from "./transport.js";
import {
  brokerStatus,
  grantId,
  grantLabel,
  grantListing,
  grantSummary,
  type BrokerGrantSummary,
  type BrokerStatus,
} from "./grants.js";
import {
  integrationDefinition,
  isIntegrationKind,
  type IntegrationKindName,
} from "./integrations.js";

export { CredentialBrokerError, maxGrantTtlSeconds } from "./transport.js";

export type { BrokerRequestOptions, IssuanceRefusal } from "./transport.js";

export type { BrokerGrantSummary, BrokerStatus } from "./grants.js";

export {
  createCredentialBrokerAdmin,
  type CredentialBrokerAdminOptions,
  type BrokerIntegration,
  type BrokerIntegrationKind,
  type BrokerIntegrationCredential,
  type BrokerEndpointCredential,
  type BrokerIntegrationInput,
  type BrokerDeploymentConfig,
  type BrokerTenantConfigInput,
  type BrokerRequestLimit,
  type BrokerWorkflowPolicy,
} from "./admin.js";

export type {
  BrokerAlertDestination,
  BrokerAlertDestinationInput,
  BrokerAlertKind,
  BrokerCanary,
  BrokerCanaryEvent,
  BrokerCanaryToken,
} from "./canaries.js";

export type { BrokerEndpoint, BrokerEndpointHeader } from "./endpoint.js";

export type CredentialBrokerAuth =
  | { apiKey: string }
  | { githubActionsOidc: (signal: AbortSignal) => Promise<string> };

export interface CredentialBrokerOptions {
  url: string;
  auth: CredentialBrokerAuth;
  fetch?: Fetch;
}

export interface BrokerGrantRequest {
  integrations: readonly string[];
  /** 1 second to 7 days. Defaults to 900. */
  ttlSeconds?: number;
  /** A name shown in grant listings, such as the sandbox the grant belongs to. */
  label?: string;
}

export type BrokerIntegrationKindName = IntegrationKindName;

export interface BrokerGrant {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly integrations: readonly string[];
  /** Each integration's kind. Brokers before API version 2 omit it. */
  readonly kinds?: Readonly<Record<string, BrokerIntegrationKindName>>;
}

export interface SandboxEndpoint {
  integration: string;
  baseURLEnv: string;
  apiKeyEnv: string;
}

export interface SandboxIntegrations {
  /**
   * Integrations whose variables follow their kind, as the broker reports it: GitHub sets up git
   * and gh, Anthropic, OpenAI and OpenRouter set `<PROVIDER>_BASE_URL` and `<PROVIDER>_API_KEY`,
   * and a generic HTTP integration sets `<ID>_BASE_URL` and `<ID>_API_KEY` (`my-api` becomes
   * `MY_API_*`). Use `endpoints` to pick other names.
   */
  integrations?: readonly string[];
  github?: string;
  anthropic?: string;
  openai?: string;
  openrouter?: string;
  endpoints?: readonly SandboxEndpoint[];
  /** 1 second to 7 days. Defaults to 900. */
  ttlSeconds?: number;
  /** A name shown in grant listings. */
  label?: string;
}

export interface SandboxGrant {
  readonly id: string;
  readonly integrations: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  revoke(signal: AbortSignal, traceParent?: string): Promise<void>;
  /** Move expiry to `ttlSeconds` from now (up to 7 days) and return the new expiry. */
  renew(ttlSeconds: number, signal: AbortSignal, traceParent?: string): Promise<string>;
}

/** The variables a GitHub integration sets so git and gh reach the broker. */
const gitVariables = [
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GIT_CONFIG_COUNT",
  "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_VALUE_1",
  "GIT_CONFIG_KEY_2",
  "GIT_CONFIG_VALUE_2",
];

function validTtl(ttlSeconds: number): boolean {
  return Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= maxGrantTtlSeconds;
}

function validateRequest({ integrations, ttlSeconds = 900, label }: BrokerGrantRequest) {
  if (
    !Array.isArray(integrations) ||
    !integrations.length ||
    integrations.length > 16 ||
    integrations.some((id) => typeof id !== "string" || !integrationName.test(id)) ||
    new Set(integrations).size !== integrations.length ||
    !validTtl(ttlSeconds) ||
    (label !== undefined && (typeof label !== "string" || !grantLabel.test(label)))
  )
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant request");

  return { integrations: [...integrations], ttlSeconds, ...(label !== undefined && { label }) };
}

/** The variables that point git and gh at the broker with a grant token. */
export function githubGrantEnv(base: URL, token: string) {
  const helper = `credential.${base.origin}/.helper`;

  return {
    GH_HOST: base.host,
    GH_ENTERPRISE_TOKEN: token,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: helper,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: helper,
    GIT_CONFIG_VALUE_1:
      '!f() { if test "$1" = get; then printf "%s\\n" username=x-access-token "password=$GH_ENTERPRISE_TOKEN"; fi; }; f',
    GIT_CONFIG_KEY_2: `url.${base.origin}/.insteadOf`,
    GIT_CONFIG_VALUE_2: "https://github.com/",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The `<PREFIX>_BASE_URL` / `<PREFIX>_API_KEY` prefix a sandbox gets for a non-GitHub integration. */
export function grantEnvPrefix(id: string, kind: BrokerIntegrationKindName): string {
  return (
    integrationDefinition(kind).family === "endpoint" ? id.replaceAll("-", "_") : kind
  ).toUpperCase();
}

/** The base URL a client should use for one integration, given its kind. */
export function integrationBaseURL(base: URL, id: string, kind: BrokerIntegrationKindName) {
  const definition = integrationDefinition(kind);
  const gateway = gatewayBaseURL(base, id);

  return definition.family === "model" ? `${gateway}${definition.clientPath}` : gateway;
}

/** Resolve a fresh GitHub Actions identity token per broker request. Run on the trusted host. */
export function githubActionsOidc(options: {
  audience: string;
  env: { ACTIONS_ID_TOKEN_REQUEST_URL?: string; ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string };
  fetch?: Fetch;
}): CredentialBrokerAuth {
  const { audience, env, fetch: transport = defaultFetch } = options;
  const { ACTIONS_ID_TOKEN_REQUEST_URL: endpoint, ACTIONS_ID_TOKEN_REQUEST_TOKEN: token } = env;

  if (!audience || !endpoint || !token || !bearerToken.test(token))
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      "GitHub Actions OIDC configuration is incomplete",
    );

  const url = httpsURL(endpoint);
  url.searchParams.set("audience", audience);

  return {
    async githubActionsOidc(signal) {
      const response = await fetchRequest(transport, url, {
        signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });

      assertStatus(response, 200);

      const reply = await waitForSignal(signal, () => jsonRecord(response));

      if (!("value" in reply) || typeof reply.value !== "string" || !bearerToken.test(reply.value))
        throw new CredentialBrokerError(
          "INVALID_RESPONSE",
          "GitHub Actions returned an invalid identity token",
        );

      return reply.value;
    },
  };
}

/** Trusted-host client. Management authentication stays in this client. */
export function createCredentialBroker(options: CredentialBrokerOptions) {
  const base = brokerOrigin(options.url);
  const transport = options.fetch ?? defaultFetch;
  const auth = { ...options.auth };

  if ("apiKey" in auth) requireApiKey(auth.apiKey);

  function operationName(path: string, method: string): string {
    if (path === "/v1/status") return "status";

    if (path.endsWith("/renew")) return "grant renewal";

    return method === "GET" ? "grant listing" : "this request";
  }

  async function management(
    path: string,
    method: "GET" | "POST" | "DELETE",
    expected: 200 | 201 | 204,
    signal: AbortSignal,
    traceParent?: string,
    body?: string,
  ) {
    let token: string;

    try {
      token =
        "apiKey" in auth
          ? auth.apiKey
          : await waitForSignal(signal, () => auth.githubActionsOidc(signal));
    } catch {
      if (signal.aborted)
        throw new CredentialBrokerError("WAIT_ABORTED", "Credential authentication was cancelled");
      throw new CredentialBrokerError("UNAUTHENTICATED", "Credential broker authentication failed");
    }

    if (typeof token !== "string" || !bearerToken.test(token))
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker authentication");

    // Issuing twice mints two grants, so a lost issuance has an unknown outcome.
    const response = await fetchRequest(
      transport,
      new URL(path, base),
      {
        method,
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body && { "content-type": "application/json" }),
          ...(traceParent && traceParentPattern.test(traceParent) && { traceparent: traceParent }),
        },
        body,
      },
      method === "POST" && path === "/v1/grants",
    );

    if (response.status === expected) return response;

    if (method === "POST" && response.status === 400) {
      const { error } = await brokerFailure(response);

      throw new CredentialBrokerError(
        "INVALID_ARGUMENT",
        error === "multiple_github_integrations"
          ? "A grant can include at most one GitHub integration"
          : path.endsWith("/renew")
            ? "Credential broker rejected the renewal request"
            : "Credential broker rejected the grant request",
      );
    }

    if (response.status === 403) {
      const { reason, integrations } = await brokerFailure(response);

      if (reason && integrations?.length)
        throw new CredentialBrokerError(
          "FORBIDDEN",
          refusalMessage(reason, integrations),
          reason,
          integrations,
        );
      throw new CredentialBrokerError("FORBIDDEN", "Credential request was denied");
    }

    if (response.status === 401) {
      void response.body?.cancel().catch(() => undefined);
      throw new CredentialBrokerError(
        "UNAUTHENTICATED",
        "apiKey" in auth
          ? "The broker rejected the issuer key. Use BROKER_ISSUER_KEY from the deployment, not the admin key"
          : "The broker rejected the GitHub Actions identity. Check the audience and the workflow policy in the broker configuration",
      );
    }

    if (response.status === 404) {
      const { error } = await brokerFailure(response);

      // A broker older than this client answers its unknown routes with 404 too.
      throw new CredentialBrokerError(
        "NOT_FOUND",
        error === "grant_not_found"
          ? "The grant was not found. It may have expired, been revoked, or belong to another issuer"
          : `This broker does not support ${operationName(path, method)}. Redeploy it from the latest credential-broker release`,
      );
    }

    if (response.status === 429) {
      const { error } = await brokerFailure(response);

      throw new CredentialBrokerError(
        "RATE_LIMIT",
        error === "grant_limit"
          ? "The broker has reached its active grant limit. Revoke unused grants or wait for them to expire"
          : "Credential endpoint is rate limiting requests",
      );
    }

    assertStatus(response, expected);

    return response;
  }

  async function issue(
    request: BrokerGrantRequest,
    options: BrokerRequestOptions = {},
  ): Promise<BrokerGrant> {
    const body = validateRequest(request);
    const budget = withRequestSignal(options.signal);

    try {
      const response = await management(
        "/v1/grants",
        "POST",
        201,
        budget.signal,
        options.traceParent,
        JSON.stringify(body),
      );

      const reply = await waitForSignal(budget.signal, () => jsonRecord(response));

      if (!("id" in reply && "token" in reply && "expiresAt" in reply && "integrations" in reply))
        throw new CredentialBrokerError(
          "INVALID_RESPONSE",
          "Credential broker returned an invalid grant",
        );
      const { id, token, expiresAt, integrations } = reply;
      const kinds = "kinds" in reply ? reply.kinds : undefined;

      if (
        typeof id !== "string" ||
        !grantId.test(id) ||
        typeof token !== "string" ||
        !sandboxToken.test(token) ||
        typeof expiresAt !== "string" ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        !Array.isArray(integrations) ||
        integrations.length !== body.integrations.length ||
        !body.integrations.every((name) => integrations.includes(name))
      )
        throw new CredentialBrokerError(
          "INVALID_RESPONSE",
          "Credential broker returned an invalid grant",
        );

      const parsedKinds =
        kinds && typeof kinds === "object" && !Array.isArray(kinds)
          ? Object.fromEntries(
              Object.entries(kinds).flatMap(([name, kind]) => {
                const known =
                  typeof kind === "string" && isIntegrationKind(kind) ? kind : undefined;

                return body.integrations.includes(name) && known ? [[name, known]] : [];
              }),
            )
          : undefined;

      return {
        id,
        token,
        expiresAt,
        integrations: body.integrations,
        ...(parsedKinds && { kinds: parsedKinds }),
      };
    } catch (error) {
      if (options.signal?.aborted)
        throw new CredentialBrokerError("WAIT_ABORTED", "Credential grant request was cancelled");

      if (budget.timeout.aborted)
        throw new CredentialBrokerError("TIMEOUT", "Credential grant request timed out");
      throw error;
    }
  }

  async function revoke(id: string, options: BrokerRequestOptions = {}): Promise<void> {
    if (typeof id !== "string" || !grantId.test(id))
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant identifier");
    const budget = withRequestSignal(options.signal);

    try {
      await management(`/v1/grants/${id}`, "DELETE", 204, budget.signal, options.traceParent);
    } catch (error) {
      if (options.signal?.aborted)
        throw new CredentialBrokerError(
          "WAIT_ABORTED",
          "Credential revocation request was cancelled",
        );

      if (budget.timeout.aborted)
        throw new CredentialBrokerError("TIMEOUT", "Credential revocation request timed out");
      throw error;
    }
  }

  async function withBudget<T>(
    options: BrokerRequestOptions,
    label: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const budget = withRequestSignal(options.signal);

    try {
      return await work(budget.signal);
    } catch (error) {
      if (options.signal?.aborted)
        throw new CredentialBrokerError("WAIT_ABORTED", `${label} was cancelled`);

      if (budget.timeout.aborted) throw new CredentialBrokerError("TIMEOUT", `${label} timed out`);
      throw error;
    }
  }

  /** Active grants issued by this issuer key or workflow run, newest first. */
  async function list(options: BrokerRequestOptions = {}): Promise<BrokerGrantSummary[]> {
    return withBudget(options, "Credential grant listing", async (signal) => {
      const response = await management("/v1/grants", "GET", 200, signal, options.traceParent);

      return grantListing(await waitForSignal(signal, () => jsonRecord(response)), false);
    });
  }

  /**
   * Move an active grant's expiry to `ttlSeconds` from now, up to 7 days per renewal. Returns the
   * grant's summary with its new `expiresAt`.
   */
  async function renew(
    id: string,
    ttlSeconds: number,
    options: BrokerRequestOptions = {},
  ): Promise<BrokerGrantSummary> {
    if (typeof id !== "string" || !grantId.test(id))
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant identifier");

    if (!validTtl(ttlSeconds))
      throw new CredentialBrokerError(
        "INVALID_ARGUMENT",
        "Grant lifetime must be 1 second to 7 days",
      );

    return withBudget(options, "Credential grant renewal", async (signal) => {
      const response = await management(
        `/v1/grants/${id}/renew`,
        "POST",
        200,
        signal,
        options.traceParent,
        JSON.stringify({ ttlSeconds }),
      );

      return grantSummary(await waitForSignal(signal, () => jsonRecord(response)), false);
    });
  }

  /** Check the broker URL and key: the role the key has and the broker's limits. */
  async function status(options: BrokerRequestOptions = {}): Promise<BrokerStatus> {
    return withBudget(options, "Credential broker status", async (signal) => {
      const response = await management("/v1/status", "GET", 200, signal, options.traceParent);

      return brokerStatus(await waitForSignal(signal, () => jsonRecord(response)));
    });
  }

  function sandbox({
    integrations: automatic = [],
    github,
    anthropic,
    openai,
    openrouter,
    endpoints = [],
    ttlSeconds,
    label,
  }: SandboxIntegrations) {
    if (!Array.isArray(automatic))
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant request");

    const integrations = [...automatic, github, anthropic, openai, openrouter].filter(
      (id) => id !== undefined,
    );

    if (
      !Array.isArray(endpoints) ||
      endpoints.some((binding) => !binding || typeof binding !== "object")
    )
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker endpoint bindings");

    if (new Set(integrations).size !== integrations.length)
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant request");

    const variables = new Set<string>();

    if (github !== undefined) {
      for (const name of gitVariables) variables.add(name);
    }

    for (const [id, prefix] of [
      [anthropic, "ANTHROPIC"],
      [openai, "OPENAI"],
      [openrouter, "OPENROUTER"],
    ]) {
      if (id === undefined) continue;
      variables.add(`${prefix}_BASE_URL`);
      variables.add(`${prefix}_API_KEY`);
    }

    const bindings = endpoints.map(({ integration, baseURLEnv, apiKeyEnv }) => {
      for (const name of [baseURLEnv, apiKeyEnv]) {
        if (
          typeof name !== "string" ||
          !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) ||
          variables.has(name)
        )
          throw new CredentialBrokerError(
            "INVALID_ARGUMENT",
            "Invalid or duplicate broker endpoint environment variable",
          );
        variables.add(name);
      }

      return { integration, baseURLEnv, apiKeyEnv };
    });

    const request = validateRequest({
      integrations: [
        ...new Set([...integrations, ...bindings.map(({ integration }) => integration)]),
      ],
      ttlSeconds,
      label,
    });

    return {
      async acquire(signal: AbortSignal, traceParent?: string): Promise<SandboxGrant> {
        const grant = await issue(request, { signal, traceParent });
        const env: Record<string, string> = {};

        // A broker that reports kinds lets each variable match its integration, including a
        // generic HTTP integration selected through a provider shorthand. Older brokers fall back
        // to the shorthand's built-in kind.
        const url = (id: string, fallback: BrokerIntegrationKindName) =>
          integrationBaseURL(base, id, grant.kinds?.[id] ?? fallback);

        const refuse = async (message: string): Promise<never> => {
          // The caller's signal may already be aborted. Revoke on the request's own time budget so
          // the refused grant does not stay live until it expires.
          await revoke(grant.id, { traceParent }).catch(() => undefined);
          throw new CredentialBrokerError("INVALID_ARGUMENT", message);
        };

        if (github !== undefined && grant.kinds && grant.kinds[github] !== "github")
          await refuse(
            `Integration ${github} is not a GitHub integration. Pass it in endpoints instead`,
          );

        // Integrations passed by id take their variables from the kind the broker reports.
        let gitHost = github;
        const prefixes: [string, string, BrokerIntegrationKindName][] = [];

        for (const id of automatic) {
          const kind = grant.kinds?.[id];

          if (!kind)
            await refuse(
              "This broker does not report integration kinds. Update it, or name each integration's variables in endpoints",
            );

          if (kind === "github") {
            if (gitHost !== undefined)
              await refuse(
                `Only one GitHub integration can configure git in a sandbox; ${gitHost} and ${id} both do`,
              );
            gitHost = id;
          } else if (kind)
            // A generic HTTP integration has no provider of its own, so its ID names the variables.
            prefixes.push([id, grantEnvPrefix(id, kind), kind]);
        }

        for (const [id, prefix] of prefixes) {
          for (const name of [`${prefix}_BASE_URL`, `${prefix}_API_KEY`]) {
            if (
              variables.has(name) ||
              prefixes.some(([other, same]) => other !== id && same === prefix)
            )
              await refuse(
                `Two integrations would set ${name}. Name one of them in endpoints with its own variables`,
              );
          }
        }

        for (const [id, prefix, kind] of prefixes) {
          env[`${prefix}_BASE_URL`] = url(id, kind);
          env[`${prefix}_API_KEY`] = grant.token;
        }

        if (gitHost !== undefined) {
          const taken = gitVariables.find((name) => github === undefined && variables.has(name));

          if (taken) await refuse(`An endpoint also sets ${taken}. Give it another variable name`);
          Object.assign(env, githubGrantEnv(base, grant.token));
        }

        if (anthropic !== undefined) {
          env.ANTHROPIC_BASE_URL = url(anthropic, "anthropic");
          env.ANTHROPIC_API_KEY = grant.token;
        }

        if (openai !== undefined) {
          env.OPENAI_BASE_URL = url(openai, "openai");
          env.OPENAI_API_KEY = grant.token;
        }

        if (openrouter !== undefined) {
          env.OPENROUTER_BASE_URL = url(openrouter, "openrouter");
          env.OPENROUTER_API_KEY = grant.token;
        }

        for (const { integration, baseURLEnv, apiKeyEnv } of bindings) {
          env[baseURLEnv] = url(integration, "http");
          env[apiKeyEnv] = grant.token;
        }

        return {
          id: grant.id,
          integrations: grant.integrations,
          env,
          expiresAt: grant.expiresAt,
          revoke: (signal, traceParent) => revoke(grant.id, { signal, traceParent }),
          renew: async (ttl, signal, traceParent) =>
            (await renew(grant.id, ttl, { signal, traceParent })).expiresAt,
        };
      },
    };
  }

  return { issue, revoke, renew, list, status, sandbox };
}
