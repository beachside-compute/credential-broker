/** Upstream credentials go in one header, with an optional value prefix such as `Bearer `. */
export interface HeaderAuth {
  readonly header: string;
  readonly prefix: string;
}

/** GitHub's REST, GraphQL and Git routes, served at fixed broker paths. */
export interface GitHubDefinition {
  readonly family: "github";
  readonly origin: string;
}

/** A model API reached through `/gateway/<id>` with a fixed origin and path allowlist. */
export interface ModelDefinition {
  readonly family: "model";
  readonly origin: string;
  /** Inserted before every upstream path, for providers that serve `/v1` below a prefix. */
  readonly upstreamPrefix: string;
  /** Appended to the gateway URL to give a client's base URL. */
  readonly clientPath: string;
  /** POST paths a grant may call. Model listing is always allowed. */
  readonly generate: readonly string[];
  readonly auth: HeaderAuth;
  /** Sent when the client does not send its own. */
  readonly defaultHeaders: Readonly<Record<string, string>>;
}

/** An administrator-configured HTTPS endpoint with its own headers. */
export interface EndpointDefinition {
  readonly family: "endpoint";
}

export type IntegrationDefinition = GitHubDefinition | ModelDefinition | EndpointDefinition;

const openAIPaths = ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"];

const bearer: HeaderAuth = { header: "authorization", prefix: "Bearer " };

export const integrationKindNames = [
  "github",
  "anthropic",
  "openai",
  "openrouter",
  "http",
] as const;

export type IntegrationKindName = (typeof integrationKindNames)[number];

export const integrationDefinitions = {
  github: { family: "github", origin: "https://github.com" },
  anthropic: {
    family: "model",

    origin: "https://api.anthropic.com",
    upstreamPrefix: "",
    clientPath: "",
    generate: ["/v1/messages", "/v1/messages/count_tokens"],
    auth: { header: "x-api-key", prefix: "" },
    defaultHeaders: { "anthropic-version": "2023-06-01" },
  },
  openai: {
    family: "model",

    origin: "https://api.openai.com",
    upstreamPrefix: "",
    clientPath: "/v1",
    generate: openAIPaths,
    auth: bearer,
    defaultHeaders: {},
  },
  openrouter: {
    family: "model",

    origin: "https://openrouter.ai",
    upstreamPrefix: "/api",
    clientPath: "/v1",
    generate: openAIPaths,
    auth: bearer,
    defaultHeaders: {},
  },
  http: { family: "endpoint" },
} as const satisfies Record<IntegrationKindName, IntegrationDefinition>;

export function integrationDefinition(kind: IntegrationKindName): IntegrationDefinition {
  return integrationDefinitions[kind];
}

export function isIntegrationKind(value: string): value is IntegrationKindName {
  return integrationKindNames.some((kind) => kind === value);
}
