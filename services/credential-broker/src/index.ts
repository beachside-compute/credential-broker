import { Hono } from "hono";
import { z } from "zod";
import { grantIdPattern, newGrantToken, tokenHash } from "./grants/tokens";
import { orchestrator } from "./auth";
import { integrationId, maxGrantTtlSeconds, parseConfig } from "./config";
import type { ResolvedCredential } from "./credentials/source";
import { workerSecretSource } from "./credentials/sources/worker-secret";
import { encryptedStoreSource, openEndpointValues } from "./credentials/sources/encrypted-store";
import { failure, upstream, withCompletion } from "./proxy/forward";
import { GrantRegistry } from "./grants/registry";
import { route, sandboxToken, upstreamRoute } from "./proxy/routes";
import { managementKeyring, privateJson, privateNoContent, readJson, registry } from "./http";
import type { Worker } from "./http";
import { adminRoutes } from "./integrations/admin";
import type { IntegrationSelector } from "./integrations/types";
import { finishSpan, grantOrigin, parseTraceparent, startSpan } from "./observability/tracing";

export { GrantRegistry };

const issueRequest = z.strictObject({
  integrations: z.array(integrationId).min(1).max(16),
  ttlSeconds: z.number().int().min(1).max(maxGrantTtlSeconds),
});

const app = new Hono<Worker>();

app.onError(() => failure(503, "broker_unavailable"));

app.route("/v1/admin", adminRoutes);

app.post("/v1/grants", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const request = context.req.raw;
  const principal = await orchestrator(request, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) return failure(401, "orchestrator_authentication_required");

  managementKeyring(context.env);

  const parent = parseTraceparent(request.headers.get("traceparent"));

  const span = startSpan(
    context.env,
    (work) => context.executionCtx.waitUntil(work),
    "grant.create",
    parent,
  );

  let status = 503;

  try {
    const input = issueRequest.safeParse(await readJson(request, 4_096));

    if (
      !input.success ||
      new Set(input.data.integrations).size !== input.data.integrations.length
    ) {
      status = 400;

      return failure(status, "invalid_grant_request");
    }

    const { integrations, ttlSeconds } = input.data;

    const token = newGrantToken();
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + ttlSeconds * 1_000;

    const result = await registry(context.env).create(
      {
        id,
        hash: await tokenHash(token),
        owner: principal.owner,
        integrations,
        expiresAt,
        traceparent: grantOrigin(span, parent),
      },
      principal,
    );

    if (result === "forbidden") {
      status = 403;

      return failure(status, "integration_forbidden");
    }

    if (result === "ambiguous_github") {
      status = 400;

      return failure(status, "multiple_github_integrations");
    }

    if (result === "limit") {
      status = 429;

      return failure(status, "grant_limit");
    }

    status = 201;

    return privateJson(
      { id, token, expiresAt: new Date(expiresAt).toISOString(), integrations },
      status,
    );
  } finally {
    finishSpan(span, status);
  }
});

app.delete("/v1/grants/:id", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const principal = await orchestrator(context.req.raw, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) return failure(401, "orchestrator_authentication_required");

  managementKeyring(context.env);

  const parent = parseTraceparent(context.req.header("traceparent") ?? null);

  const span = startSpan(
    context.env,
    (work) => context.executionCtx.waitUntil(work),
    "grant.revoke",
    parent,
  );

  let status = 503;

  try {
    const id = context.req.param("id");

    if (!grantIdPattern.test(id)) {
      status = 400;

      return failure(status, "invalid_grant_id");
    }

    await registry(context.env).revoke(id, principal.owner);
    status = 204;

    return privateNoContent();
  } finally {
    finishSpan(span, status);
  }
});

app.all("*", async (context) => {
  const request = context.req.raw;
  const requestUrl = new URL(request.url);
  const incoming = route(requestUrl, request.method);

  if (!incoming) return failure(404, "unsupported_route");

  const token = sandboxToken(request, incoming);
  const isGit = incoming.type === "git";

  if (!token) return failure(401, "grant_authentication_required", isGit);

  const store = registry(context.env);

  const selector: IntegrationSelector =
    incoming.type === "gateway" ? { type: "gateway", id: incoming.id } : { type: "github" };

  const authorized = await store.authorize(
    await tokenHash(token),
    selector,
    request.headers.has("x-api-key"),
  );

  if (authorized.status === "invalid") return failure(401, "grant_invalid", isGit);

  if (authorized.status === "forbidden") return failure(403, "integration_forbidden");

  if (authorized.status !== "allowed") return failure(429, "grant_request_limit");

  const origin = parseTraceparent(authorized.traceparent);

  const span = startSpan(
    context.env,
    (work) => context.executionCtx.waitUntil(work),
    "gateway",
    undefined,
    origin,
  );

  let completed = false;

  const complete = (status: number, failed?: boolean) => {
    if (completed) return;
    completed = true;
    finishSpan(span, status, failed);
    // A lost release can hold a slot until this grant expires. It never widens access.
    context.executionCtx.waitUntil(store.release(authorized.leaseId).catch(() => {}));
  };

  const { integration } = authorized;
  const target = upstreamRoute(incoming, integration);

  const blockedEndpoint =
    target?.type === "http" &&
    (request.headers.has("upgrade") ||
      decodeURIComponent(requestUrl.pathname).includes(token) ||
      [...requestUrl.searchParams].some(
        ([name, value]) => name.includes(token) || value.includes(token),
      ));

  if (!target || blockedEndpoint) {
    complete(404);

    return failure(404, "unsupported_route");
  }

  let credential: ResolvedCredential | { values: Record<string, string> } | undefined;

  try {
    const reference = integration.credential;

    if (integration.kind === "http") {
      if (reference.source === "encrypted-store") {
        const values = await openEndpointValues(
          reference,
          integration,
          managementKeyring(context.env),
        );

        if (values) credential = { values };
      }
    } else {
      credential =
        reference.source === "worker-secret"
          ? await workerSecretSource(context.env).resolve(reference)
          : await encryptedStoreSource(integration, managementKeyring(context.env)).resolve(
              reference,
            );
    }
  } catch {
    complete(503);

    return failure(503, "credential_unavailable");
  }

  if (!credential) {
    complete(503);

    return failure(503, "credential_unavailable");
  }

  try {
    const response = await upstream(request, target, credential, token);

    return withCompletion(response, (failed) => complete(response.status, failed));
  } catch {
    complete(502);

    return failure(502, "upstream_unavailable");
  }
});

export default app;
