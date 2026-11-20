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
  traceParentPattern,
  waitForSignal,
  withRequestSignal,
  type BrokerRequestOptions,
  type Fetch,
} from "./transport.js";

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

      if ([400, 404, 409, 413].includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);

        if (response.status === 404)
          throw new CredentialBrokerError(
            "NOT_FOUND",
            "Credential broker admin resource was not found",
          );

        if (response.status === 409)
          throw new CredentialBrokerError(
            "CONFLICT",
            "Broker configuration changed or the integration already exists",
          );

        throw new CredentialBrokerError(
          "INVALID_ARGUMENT",
          "Credential broker rejected the admin request",
        );
      }

      assertStatus(response, expected);

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
    method: "GET" | "POST" | "PUT" | "PATCH",
    expected: 200 | 201,
    call: BrokerRequestOptions,
    parse: (reply: JsonReply) => T,
    body?: string,
  ) {
    return request(path, method, expected, call, body, async (response, signal) =>
      parse(await waitForSignal(signal, () => jsonRecord(response))),
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
        return json(itemPath(id), "GET", 200, call, (reply) => integrationMetadata(reply, id));
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
        );
      },
    },
  };
}
