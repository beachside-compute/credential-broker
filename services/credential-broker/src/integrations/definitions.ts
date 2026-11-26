import { integrationDefinitions, integrationKindNames } from "../../../../src/integrations";
import type {
  EndpointDefinition,
  GitHubDefinition,
  HeaderAuth,
  IntegrationKindName,
  ModelDefinition,
} from "../../../../src/integrations";

export interface RequestLimit {
  requestsPerMinute: number;
  concurrentRequests: number;
}

/** Where a single-value upstream credential is placed on a forwarded request. */
export type Authorize = (
  headers: Headers,
  credential: string,
  route: "api" | "git" | "ai" | "http",
) => void;

interface Behaviour {
  /** Default per grant and integration. Git clones and fetches burst far more than model calls. */
  limit: RequestLimit;
  /** Whether a sandbox may present its grant in `x-api-key`. */
  apiKeyHeader: boolean;
  /** The largest stored credential plaintext. */
  maxCredentialBytes: number;
}

export type BrokerIntegration =
  | (GitHubDefinition & Behaviour & { authorize: Authorize })
  | (ModelDefinition & Behaviour & { authorize: Authorize })
  | (EndpointDefinition & Behaviour);

function headerAuth({ header, prefix }: HeaderAuth, defaults: Readonly<Record<string, string>>) {
  return (headers: Headers, credential: string) => {
    headers.set(header, `${prefix}${credential}`);

    for (const [name, value] of Object.entries(defaults))
      if (!headers.has(name)) headers.set(name, value);
  };
}

function model(definition: ModelDefinition): BrokerIntegration {
  return {
    ...definition,
    limit: { requestsPerMinute: 600, concurrentRequests: 32 },
    apiKeyHeader: definition.auth.header === "x-api-key",
    maxCredentialBytes: 4096,
    authorize: headerAuth(definition.auth, definition.defaultHeaders),
  };
}

export const brokerIntegrations: Record<IntegrationKindName, BrokerIntegration> = {
  github: {
    ...integrationDefinitions.github,
    limit: { requestsPerMinute: 800, concurrentRequests: 32 },
    apiKeyHeader: false,
    maxCredentialBytes: 4096,
    authorize(headers, credential, route) {
      headers.set(
        "authorization",
        route === "git" ? `Basic ${btoa(`x-access-token:${credential}`)}` : `Bearer ${credential}`,
      );
    },
  },
  anthropic: model(integrationDefinitions.anthropic),
  openai: model(integrationDefinitions.openai),
  openrouter: model(integrationDefinitions.openrouter),
  http: {
    ...integrationDefinitions.http,
    limit: { requestsPerMinute: 300, concurrentRequests: 8 },
    apiKeyHeader: true,
    maxCredentialBytes: 67_000,
  },
};

export function brokerIntegration(kind: IntegrationKindName): BrokerIntegration {
  return brokerIntegrations[kind];
}

export function kindsIn(family: BrokerIntegration["family"]): IntegrationKindName[] {
  return integrationKindNames.filter((kind) => brokerIntegrations[kind].family === family);
}
