/* oxlint-disable anti-slop/no-runtime-typeof -- Validate broker responses and credentials at the HTTP trust boundary. */

import {
  assertStatus,
  bearerToken,
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

export { CredentialBrokerError } from "./transport.js";

export type { BrokerRequestOptions } from "./transport.js";

export {
  createCredentialBrokerAdmin,
  type CredentialBrokerAdminOptions,
  type BrokerIntegration,
  type BrokerIntegrationKind,
  type BrokerIntegrationCredential,
  type BrokerEndpointCredential,
  type BrokerIntegrationInput,
} from "./admin.js";

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
  ttlSeconds?: number;
}

export interface BrokerGrant {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly integrations: readonly string[];
}

export interface SandboxEndpoint {
  integration: string;
  baseURLEnv: string;
  apiKeyEnv: string;
}

export interface SandboxIntegrations {
  github?: string;
  anthropic?: string;
  openai?: string;
  openrouter?: string;
  endpoints?: readonly SandboxEndpoint[];
  ttlSeconds?: number;
}

export interface SandboxGrant {
  readonly env: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  revoke(signal: AbortSignal, traceParent?: string): Promise<void>;
}

const grantId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateRequest({ integrations, ttlSeconds = 900 }: BrokerGrantRequest) {
  if (
    !Array.isArray(integrations) ||
    !integrations.length ||
    integrations.length > 16 ||
    integrations.some((id) => typeof id !== "string" || !integrationName.test(id)) ||
    new Set(integrations).size !== integrations.length ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 3600
  )
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant request");

  return { integrations: [...integrations], ttlSeconds };
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

  async function management(
    path: string,
    method: "POST" | "DELETE",
    expected: 201 | 204,
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

    const response = await fetchRequest(transport, new URL(path, base), {
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body && { "content-type": "application/json" }),
        ...(traceParent && traceParentPattern.test(traceParent) && { traceparent: traceParent }),
      },
      body,
    });

    if (method === "POST" && response.status === 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new CredentialBrokerError(
        "INVALID_ARGUMENT",
        "Credential broker rejected the grant request",
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

      return { id, token, expiresAt, integrations: body.integrations };
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

  function sandbox({
    github,
    anthropic,
    openai,
    openrouter,
    endpoints = [],
    ttlSeconds,
  }: SandboxIntegrations) {
    const integrations = [github, anthropic, openai, openrouter].filter((id) => id !== undefined);

    if (
      !Array.isArray(endpoints) ||
      endpoints.some((binding) => !binding || typeof binding !== "object")
    )
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker endpoint bindings");

    if (new Set(integrations).size !== integrations.length)
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant request");

    const variables = new Set<string>();

    if (github !== undefined) {
      for (const name of [
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
      ])
        variables.add(name);
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
    });

    return {
      async acquire(signal: AbortSignal, traceParent?: string): Promise<SandboxGrant> {
        const grant = await issue(request, { signal, traceParent });
        const env: Record<string, string> = {};

        if (github !== undefined) {
          env.GH_HOST = base.host;
          env.GH_ENTERPRISE_TOKEN = grant.token;
          env.GIT_CONFIG_COUNT = "3";
          env.GIT_CONFIG_KEY_0 = `credential.${base.origin}/.helper`;
          env.GIT_CONFIG_VALUE_0 = "";
          env.GIT_CONFIG_KEY_1 = env.GIT_CONFIG_KEY_0;
          env.GIT_CONFIG_VALUE_1 =
            '!f() { if test "$1" = get; then printf "%s\\n" username=x-access-token "password=$GH_ENTERPRISE_TOKEN"; fi; }; f';
          env.GIT_CONFIG_KEY_2 = `url.${base.origin}/.insteadOf`;
          env.GIT_CONFIG_VALUE_2 = "https://github.com/";
          env.GIT_TERMINAL_PROMPT = "0";
        }

        if (anthropic !== undefined) {
          env.ANTHROPIC_BASE_URL = gatewayBaseURL(base, anthropic);
          env.ANTHROPIC_API_KEY = grant.token;
        }

        if (openai !== undefined) {
          env.OPENAI_BASE_URL = `${gatewayBaseURL(base, openai)}/v1`;
          env.OPENAI_API_KEY = grant.token;
        }

        if (openrouter !== undefined) {
          env.OPENROUTER_BASE_URL = `${gatewayBaseURL(base, openrouter)}/v1`;
          env.OPENROUTER_API_KEY = grant.token;
        }

        for (const { integration, baseURLEnv, apiKeyEnv } of bindings) {
          env[baseURLEnv] = gatewayBaseURL(base, integration);
          env[apiKeyEnv] = grant.token;
        }

        return {
          env,
          expiresAt: grant.expiresAt,
          revoke: (signal, traceParent) => revoke(grant.id, { signal, traceParent }),
        };
      },
    };
  }

  return { issue, revoke, sandbox };
}
