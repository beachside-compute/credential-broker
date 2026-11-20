import { bearer, grantTokenPattern } from "../grants/tokens";
import type { IntegrationTarget } from "../integrations/types";

const aiOrigins = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai",
};

const repo = "[A-Za-z0-9_.-]+";

const repository = `(?:repos/${repo}/${repo}|repositories/[0-9]+)`;

const repoRead = new RegExp(
  `^/${repository}(?:/(?:branches(?:/[A-Za-z0-9_.-]+)?|commits(?:/[A-Za-z0-9_.-]+)?|labels(?:/[^/]+)?|milestones(?:/[0-9]+)?|issues(?:/comments/[0-9]+|/[0-9]+(?:/(?:comments|labels|assignees|timeline))?)?|pulls(?:/[0-9]+(?:/(?:comments|commits|files|reviews|requested_reviewers))?)?))?$`,
);

const repoWrite = new RegExp(
  `^/${repository}/(?:issues(?:/comments/[0-9]+|/[0-9]+(?:/(?:comments|labels|assignees))?)?|pulls(?:/[0-9]+(?:/(?:comments|reviews|requested_reviewers|merge|update-branch))?)?)$`,
);

const gitPath = new RegExp(`^(/${repo}/${repo})/(info/refs|git-upload-pack|git-receive-pack)$`);

const aiPath = /^\/gateway\/([a-z][a-z0-9-]{0,31})(\/v1\/[A-Za-z0-9_.:/-]+)$/;

const safePath = /^(?:\/(?:[A-Za-z0-9_.~:-]|%(?:20|[89a-f][0-9a-f]))+)+\/?$/i;

const sensitiveQuery =
  /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|credential|key|password|signature|token)$/i;

export interface Route {
  type: "api" | "git" | "ai";
  integration: IntegrationTarget;
  url: URL;
}

export type RequestRoute =
  | { type: "api" | "git"; url: URL }
  | { type: "ai"; id: string; path: string; search: string; method: string };

export function route(requestUrl: URL, method: string): RequestRoute | undefined {
  const { pathname, search } = requestUrl;

  for (const key of requestUrl.searchParams.keys()) {
    if (sensitiveQuery.test(key)) return;
  }

  const ai = pathname.match(aiPath);

  if (ai) {
    const [, id, path] = ai;

    if (!aiAllowed("anthropic", path, method) && !aiAllowed("openai", path, method)) return;

    return { type: "ai", id, path, search, method };
  }

  if (pathname === "/api/graphql" && method === "POST" && !search) {
    return { type: "api", url: new URL("https://api.github.com/graphql") };
  }

  if (pathname === "/api/v3" || pathname.startsWith("/api/v3/")) {
    const path = pathname.slice("/api/v3".length) || "/";

    if (!githubAllowed(path, method)) return;

    return {
      type: "api",
      url: new URL(`https://api.github.com${path}${search}`),
    };
  }

  const git = pathname.match(gitPath);

  if (!git) return;

  const [, repositoryPath, endpoint] = git;

  if (endpoint === "info/refs") {
    if (method !== "GET" || !/^\?service=git-(upload|receive)-pack$/.test(search)) return;
  } else if (method !== "POST" || search) {
    return;
  }

  const remote = repositoryPath.endsWith(".git") ? repositoryPath : `${repositoryPath}.git`;

  return {
    type: "git",
    url: new URL(`https://github.com${remote}/${endpoint}${search}`),
  };
}

export function upstreamRoute(
  request: RequestRoute,
  integration: IntegrationTarget,
): Route | undefined {
  if (request.type !== "ai") {
    return integration.kind === "github" ? { ...request, integration } : undefined;
  }

  const { kind } = integration;
  const { path, search, method, id } = request;

  if (kind === "github" || id !== integration.id || !aiAllowed(kind, path, method)) return;

  const prefix = kind === "openrouter" ? "/api" : "";

  return { type: "ai", integration, url: new URL(`${prefix}${path}${search}`, aiOrigins[kind]) };
}

function aiAllowed(kind: keyof typeof aiOrigins, path: string, method: string): boolean {
  if (
    (method === "GET" || method === "HEAD") &&
    /^\/v1\/models(?:\/[a-zA-Z0-9_.:-]+)?$/.test(path)
  ) {
    return true;
  }

  if (method !== "POST") return false;

  if (kind === "anthropic") return path === "/v1/messages" || path === "/v1/messages/count_tokens";

  return path === "/v1/chat/completions" || path === "/v1/responses" || path === "/v1/embeddings";
}

function githubAllowed(path: string, method: string): boolean {
  // Reject any encoding that could change route interpretation at the upstream.
  if (path !== "/" && !safePath.test(path)) return false;

  if (method === "GET" || method === "HEAD") {
    return (
      [
        "/",
        "/user",
        "/user/repos",
        "/search/issues",
        "/search/repositories",
        "/rate_limit",
      ].includes(path) ||
      /^\/orgs\/[A-Za-z0-9-]+\/repos$/.test(path) ||
      /^\/users\/[A-Za-z0-9-]+\/repos$/.test(path) ||
      repoRead.test(path)
    );
  }

  return ["POST", "PUT", "PATCH", "DELETE"].includes(method) && repoWrite.test(path);
}

export function sandboxToken(request: Request, target: RequestRoute): string | undefined {
  const authorization = request.headers.get("authorization");
  const key = request.headers.get("x-api-key");

  if (authorization !== null && key !== null) return;
  let token = bearer(authorization);

  if (!token && target.type === "git") token = gitBasic(authorization);

  if (!token && target.type === "api") token = authorization?.match(/^token ([!-~]+)$/i)?.[1];

  if (authorization === null && target.type === "ai") token = key ?? undefined;

  return token && grantTokenPattern.test(token) ? token : undefined;
}

function gitBasic(authorization: string | null): string | undefined {
  const encoded = authorization?.match(/^Basic ([A-Za-z0-9+/=]{1,192})$/i)?.[1];

  if (!encoded) return;

  try {
    return atob(encoded).match(/^x-access-token:([!-~]+)$/)?.[1];
  } catch {
    return;
  }
}

export function brokerLink(value: string, target: Route): string | undefined {
  const upstreamLink = URL.parse(value, target.url.href);

  if (
    !upstreamLink ||
    upstreamLink.origin !== target.url.origin ||
    upstreamLink.username ||
    upstreamLink.password ||
    upstreamLink.hash
  )
    return;

  let path = upstreamLink.pathname;

  if (target.type === "api") {
    if (path === "/graphql") return;
    path = `/api/v3${path}`;
  } else if (target.type === "ai") {
    const prefix = target.integration.kind === "openrouter" ? "/api" : "";

    if (!path.startsWith(`${prefix}/v1/`)) return;
    path = `/gateway/${target.integration.id}${path.slice(prefix.length)}`;
  }

  const candidate = `${path}${upstreamLink.search}`;
  const parsed = route(new URL(candidate, "https://broker.invalid"), "GET");
  const redirected = parsed && upstreamRoute(parsed, target.integration);

  return redirected?.url.href === upstreamLink.href && redirected.type === target.type
    ? candidate
    : undefined;
}
