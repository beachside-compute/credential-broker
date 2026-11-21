/* oxlint-disable anti-slop/no-runtime-typeof -- Validate admin inputs and HTTP response fields at the boundary. */

import {
  matchingEndpointValues,
  normalizeEndpoint,
  normalizeEndpointValues,
  type BrokerEndpoint,
} from "./endpoint.js";

import {
  assertStatus,
  brokerOrigin,
  CredentialBrokerError,
  defaultFetch,
  fetchRequest,
  integrationName,
  jsonRecord,
  requireApiKey,
  brokerFailure,
  hint,
  traceParentPattern,
  waitForSignal,
  withRequestSignal,
  type BrokerRequestOptions,
  type Fetch,
} from "./transport.js";
import {
  brokerStatus,
  grantListing,
  type BrokerGrantSummary,
  type BrokerStatus,
} from "./grants.js";

const integrationKinds = ["github", "anthropic", "openai", "openrouter", "http"] as const;

export type BrokerIntegrationKind = (typeof integrationKinds)[number];

export type BrokerIntegrationCredential =
  | { source: "encrypted-store"; value: string }
  | { source: "worker-secret"; binding: string };

export interface BrokerEndpointCredential {
  source: "encrypted-store";
  values: Record<string, string>;
}

export type BrokerIntegrationInput =
  | {
      id: string;
      kind: Exclude<BrokerIntegrationKind, "http">;
      credential: BrokerIntegrationCredential;
    }
  | { id: string; kind: "http"; endpoint: BrokerEndpoint; credential: BrokerEndpointCredential };

export interface BrokerIntegration {
  readonly id: string;
  /** Whether the issuer allowlist includes it. Listings and `get` report it. */
  readonly issuable?: boolean;
  readonly kind: BrokerIntegrationKind;
  readonly enabled: boolean;
  readonly endpoint?: BrokerEndpoint;
  readonly credentialSource: BrokerIntegrationCredential["source"];
  readonly credentialVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialBrokerAdminOptions {
  url: string;
  /** The admin API key. Keep it on the trusted operator host. */
  apiKey: string;
  fetch?: Fetch;
}

const integrationPath = "/v1/admin/integrations";

const permissionsPath = "/v1/admin/issuer-permissions";

const maxIntegrations = 100;

const secretBinding = /^CREDENTIAL_[A-Z][A-Z0-9_]{0,79}$/;

const secretValue = /^[\x21-\x7e]{1,4096}$/;

const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isKind(value: string): value is BrokerIntegrationKind {
  return integrationKinds.some((kind) => kind === value);
}

function requireId(id: string) {
  if (typeof id !== "string" || !integrationName.test(id))
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker integration identifier");

  return id;
}

function credentialInput(credential: BrokerIntegrationCredential): BrokerIntegrationCredential {
  if (
    credential?.source === "encrypted-store" &&
    typeof credential.value === "string" &&
    secretValue.test(credential.value)
  )
    return { source: credential.source, value: credential.value };

  if (
    credential?.source === "worker-secret" &&
    typeof credential.binding === "string" &&
    secretBinding.test(credential.binding)
  )
    return { source: credential.source, binding: credential.binding };

  throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker integration credential");
}

function endpointCredential(credential: BrokerEndpointCredential): BrokerEndpointCredential {
  const values =
    credential?.source === "encrypted-store" && normalizeEndpointValues(credential.values);

  if (!values)
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker endpoint credentials");

  return { source: "encrypted-store", values };
}

function validIdentifiers(ids: readonly unknown[]): ids is string[] {
  return (
    ids.length <= maxIntegrations &&
    ids.every((id) => typeof id === "string" && integrationName.test(id)) &&
    new Set(ids).size === ids.length
  );
}

type JsonReply = Awaited<ReturnType<typeof jsonRecord>>;

function invalidResponse() {
  return new CredentialBrokerError(
    "INVALID_RESPONSE",
    "Credential broker returned invalid admin metadata",
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Individual records from an untrusted HTTP array are parsed here.
function integrationMetadata(reply: unknown, expectedId?: string): BrokerIntegration {
  if (
    !reply ||
    typeof reply !== "object" ||
    !(
      "id" in reply &&
      "kind" in reply &&
      "enabled" in reply &&
      "credentialSource" in reply &&
      "credentialVersion" in reply &&
      "createdAt" in reply &&
      "updatedAt" in reply
    )
  )
    throw invalidResponse();
  const { id, kind, enabled, credentialSource, credentialVersion, createdAt, updatedAt } = reply;

  if (
    typeof id !== "string" ||
    !integrationName.test(id) ||
    (expectedId !== undefined && id !== expectedId) ||
    typeof kind !== "string" ||
    !isKind(kind) ||
    typeof enabled !== "boolean" ||
    (credentialSource !== "encrypted-store" && credentialSource !== "worker-secret") ||
    typeof credentialVersion !== "number" ||
    !Number.isSafeInteger(credentialVersion) ||
    credentialVersion < 1 ||
    typeof createdAt !== "string" ||
    !utcTimestamp.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof updatedAt !== "string" ||
    !utcTimestamp.test(updatedAt) ||
    !Number.isFinite(Date.parse(updatedAt))
  )
    throw invalidResponse();

  const endpoint = kind === "http" && "endpoint" in reply && normalizeEndpoint(reply.endpoint);

  if (kind === "http" && (!endpoint || credentialSource !== "encrypted-store"))
    throw invalidResponse();

  return {
    id,
    kind,
    enabled,
    credentialSource,
    credentialVersion,
    createdAt,
    updatedAt,
    ...(endpoint && { endpoint }),
    ...("issuable" in reply && typeof reply.issuable === "boolean" && { issuable: reply.issuable }),
  };
}

/** Trusted operator client for runtime integrations and grant issuance eligibility. */
export function createCredentialBrokerAdmin(options: CredentialBrokerAdminOptions) {
  const base = brokerOrigin(options.url);
  const { apiKey, fetch: transport = defaultFetch } = options;

  requireApiKey(apiKey);

  async function request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    expected: 200 | 201 | 204,
    call: BrokerRequestOptions,
    body: string | undefined,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
    subject?: string,
  ): Promise<T> {
    const budget = withRequestSignal(call.signal);
    const traceParent = call.traceParent;

    try {
      const response = await fetchRequest(transport, new URL(path, base), {
        method,
        signal: budget.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body !== undefined && { "content-type": "application/json" }),
          ...(traceParent && traceParentPattern.test(traceParent) && { traceparent: traceParent }),
        },
        body,
      });

      if (response.status !== expected) throw await adminFailure(response, subject);

      return await read(response, budget.signal);
    } catch (error) {
      if (call.signal?.aborted)
        throw new CredentialBrokerError(
          "WAIT_ABORTED",
          "Credential broker admin request was cancelled",
        );

      if (budget.timeout.aborted)
        throw new CredentialBrokerError("TIMEOUT", "Credential broker admin request timed out");

      throw error;
    }
  }

  function json<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    expected: 200 | 201,
    call: BrokerRequestOptions,
    parse: (reply: JsonReply) => T,
    body?: string,
    subject?: string,
  ) {
    return request(
      path,
      method,
      expected,
      call,
      body,
      async (response, signal) => parse(await waitForSignal(signal, () => jsonRecord(response))),
      subject,
    );
  }

  const itemPath = (id: string) => `${integrationPath}/${requireId(id)}`;

  const permissions = (reply: JsonReply) => {
    if (
      !("integrations" in reply) ||
      !Array.isArray(reply.integrations) ||
      !validIdentifiers(reply.integrations)
    )
      throw invalidResponse();

    return { integrations: [...reply.integrations] };
  };

  return {
    integrations: {
      async list(call: BrokerRequestOptions = {}) {
        return json(integrationPath, "GET", 200, call, (reply) => {
          if (
            !("integrations" in reply) ||
            !Array.isArray(reply.integrations) ||
            reply.integrations.length > maxIntegrations
          )
            throw invalidResponse();

          const result = reply.integrations.map((item) => integrationMetadata(item));

          if (!validIdentifiers(result.map(({ id }) => id))) throw invalidResponse();

          return result;
        });
      },
      async get(id: string, call: BrokerRequestOptions = {}) {
        return json(
          itemPath(id),
          "GET",
          200,
          call,
          (reply) => integrationMetadata(reply, id),
          undefined,
          id,
        );
      },
      async create(input: BrokerIntegrationInput, call: BrokerRequestOptions = {}) {
        const id = requireId(input.id);

        if (!isKind(input.kind))
          throw new CredentialBrokerError(
            "INVALID_ARGUMENT",
            "Unsupported credential broker integration kind",
          );

        let body: BrokerIntegrationInput;

        if (input.kind === "http") {
          const endpoint = normalizeEndpoint(input.endpoint);
          const credential = endpointCredential(input.credential);

          if (!endpoint || !matchingEndpointValues(endpoint, credential.values, "full"))
            throw new CredentialBrokerError(
              "INVALID_ARGUMENT",
              "Invalid broker endpoint configuration",
            );

          body = { id, kind: input.kind, endpoint, credential };
        } else {
          body = { id, kind: input.kind, credential: credentialInput(input.credential) };
        }

        return json(
          integrationPath,
          "POST",
          201,
          call,
          (reply) => integrationMetadata(reply, id),
          JSON.stringify(body),
          id,
        );
      },
      async rotate(
        id: string,
        credential: BrokerIntegrationCredential | BrokerEndpointCredential,
        call: BrokerRequestOptions = {},
      ) {
        return json(
          `${itemPath(id)}/credential`,
          "PUT",
          200,
          call,
          (reply) => integrationMetadata(reply, id),
          JSON.stringify(
            credential?.source === "encrypted-store" && "values" in credential
              ? endpointCredential(credential)
              : credentialInput(credential),
          ),
          id,
        );
      },
      async setEnabled(id: string, enabled: boolean, call: BrokerRequestOptions = {}) {
        if (typeof enabled !== "boolean")
          throw new CredentialBrokerError(
            "INVALID_ARGUMENT",
            "Invalid broker integration enabled state",
          );

        return json(
          itemPath(id),
          "PATCH",
          200,
          call,
          (reply) => integrationMetadata(reply, id),
          JSON.stringify({ enabled }),
          id,
        );
      },
      async delete(id: string, call: BrokerRequestOptions = {}) {
        await request(itemPath(id), "DELETE", 204, call, undefined, async () => {});
      },
    },
    issuerPermissions: {
      async get(call: BrokerRequestOptions = {}) {
        return json(permissionsPath, "GET", 200, call, permissions);
      },
      async set(integrations: readonly string[], call: BrokerRequestOptions = {}) {
        if (!Array.isArray(integrations) || !validIdentifiers(integrations))
          throw new CredentialBrokerError(
            "INVALID_ARGUMENT",
            "Invalid broker issuer integration allowlist",
          );

        return json(
          permissionsPath,
          "PUT",
          200,
          call,
          permissions,
          JSON.stringify({ integrations }),
          integrations.join(", "),
        );
      },
      /** Allow one integration to issue grants, keeping the rest of the list. */
      async allow(id: string, call: BrokerRequestOptions = {}) {
        return json(
          `${permissionsPath}/${requireId(id)}`,
          "PUT",
          200,
          call,
          permissions,
          undefined,
          id,
        );
      },
      /** Stop new grants for one integration. Existing grants stay valid until they end. */
      async deny(id: string, call: BrokerRequestOptions = {}) {
        return json(
          `${permissionsPath}/${requireId(id)}`,
          "DELETE",
          200,
          call,
          permissions,
          undefined,
          id,
        );
      },
    },
    grants: {
      /** Every active grant on the broker, with its issuing authority. */
      async list(call: BrokerRequestOptions = {}): Promise<BrokerGrantSummary[]> {
        return json("/v1/admin/grants", "GET", 200, call, (reply) => grantListing(reply, true));
      },
    },
    /** The deployment's GitHub Actions trust policy. Worker secret binding names stay private. */
    async config(call: BrokerRequestOptions = {}): Promise<BrokerDeploymentConfig> {
      return json("/v1/admin/config", "GET", 200, call, deploymentConfig);
    },
    /** Check the broker URL and admin key, with integration and grant counts. */
    async status(call: BrokerRequestOptions = {}): Promise<BrokerStatus> {
      return json("/v1/status", "GET", 200, call, brokerStatus, undefined, "status");
    },
  };
}

export interface BrokerDeploymentConfig {
  readonly githubActions: {
    readonly audience: string;
    readonly workflows: readonly BrokerWorkflowPolicy[];
  } | null;
  readonly workerSecretBindings: number;
  readonly issuerKey: boolean;
}

type PolicyValue = string | readonly string[];

/** One GitHub Actions workflow policy, as the broker's admin config reports it. */
export type BrokerWorkflowPolicy = Readonly<Partial<Record<string, PolicyValue>>>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A workflow policy from an untrusted HTTP body.
function workflowPolicy(workflow: unknown): BrokerWorkflowPolicy {
  if (!workflow || typeof workflow !== "object") throw invalidResponse();

  return Object.fromEntries(
    Object.entries(workflow).flatMap(([key, value]): [string, PolicyValue][] => {
      if (typeof value === "string") return [[key, value]];

      if (Array.isArray(value) && value.every((item) => typeof item === "string"))
        return [[key, value.map(String)]];

      return [];
    }),
  );
}

function deploymentConfig(reply: JsonReply): BrokerDeploymentConfig {
  if (!("githubActions" in reply && "workerSecretBindings" in reply && "issuerKey" in reply))
    throw invalidResponse();

  const { githubActions, workerSecretBindings, issuerKey } = reply;

  if (typeof workerSecretBindings !== "number" || typeof issuerKey !== "boolean")
    throw invalidResponse();

  if (githubActions === null) return { githubActions: null, workerSecretBindings, issuerKey };

  if (
    !githubActions ||
    typeof githubActions !== "object" ||
    !("audience" in githubActions) ||
    typeof githubActions.audience !== "string" ||
    !("workflows" in githubActions) ||
    !Array.isArray(githubActions.workflows)
  )
    throw invalidResponse();

  return {
    githubActions: {
      audience: githubActions.audience,
      workflows: githubActions.workflows.map(workflowPolicy),
    },
    workerSecretBindings,
    issuerKey,
  };
}

const adminMessages = {
  integration_not_found: (id) =>
    `Integration ${id} was not found. List integrations with \`${hint("integration list")}\``,
  integration_exists: (id) =>
    `Integration ${id} already exists. Pick another ID, or rotate its credential with \`${hint(`integration rotate ${id}`)}\``,
  integration_changed: () => "The integration changed during the request. Check it and retry",
  integration_limit: () => "The broker already holds its limit of 100 integrations",
  invalid_credential: () =>
    "The broker rejected the credential. Built-in kinds take --secret-stdin or --worker-secret. HTTP integrations take --credentials-stdin with a JSON map of header names to new values",
  invalid_integration: () => "The broker rejected the integration configuration",
  invalid_integration_id: () =>
    "Integration IDs use 1 to 32 lowercase letters, digits or hyphens, starting with a letter",
  invalid_issuer_permissions: () => "The broker rejected the issuer allowlist",
  credential_unavailable: () =>
    "The Worker secret binding is not declared in BROKER_CONFIG.workerSecretBindings or has no value on the deployment",
} satisfies Readonly<Record<string, (subject: string) => string>>;

function adminMessage(error: string | undefined) {
  for (const [code, message] of Object.entries(adminMessages)) if (code === error) return message;
}

async function adminFailure(response: Response, subject = "") {
  const { error } = await brokerFailure(response);
  const known = adminMessage(error);

  switch (response.status) {
    case 400:
    case 413:
      return new CredentialBrokerError(
        "INVALID_ARGUMENT",
        known ? known(subject) : "Credential broker rejected the admin request",
      );
    case 401:
      return new CredentialBrokerError(
        "UNAUTHENTICATED",
        "The broker rejected the admin key. Use BROKER_ADMIN_KEY from the deployment, not the issuer key",
      );
    case 404:
      return new CredentialBrokerError(
        "NOT_FOUND",
        known
          ? known(subject)
          : subject === "status"
            ? "This broker does not support status. Redeploy it from the latest credential-broker release"
            : "Credential broker admin resource was not found",
      );
    case 409:
      return new CredentialBrokerError(
        "CONFLICT",
        known ? known(subject) : "Broker configuration changed or the integration already exists",
      );
    case 429:
      return new CredentialBrokerError(
        "RATE_LIMIT",
        known ? known(subject) : "Credential endpoint is rate limiting requests",
      );
    case 503:
      if (error === "credential_unavailable" && known)
        return new CredentialBrokerError("UNAVAILABLE", known(subject));
  }

  try {
    assertStatus(response, -1);
  } catch (failure) {
    return failure;
  }

  return invalidResponse();
}
