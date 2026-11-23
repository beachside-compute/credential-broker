import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { grantIdPattern, newGrantToken, tokenHash } from "./grants/tokens";
import { administrator, orchestrator } from "./auth";
import { apiVersion, grantLabel, integrationId, maxGrantTtlSeconds, parseConfig } from "./config";
import type { ResolvedCredential } from "./credentials/source";
import { workerSecretSource } from "./credentials/sources/worker-secret";
import { encryptedStoreSource, openEndpointValues } from "./credentials/sources/encrypted-store";
import { failure, upstream, withCompletion } from "./proxy/forward";
import { GrantRegistry, leaseTtlMs } from "./grants/registry";
import { grantView } from "./grants/view";
import { route, sandboxToken, upstreamRoute } from "./proxy/routes";
import { managementKeyring, privateJson, privateNoContent, readJson, registry } from "./http";
import type { Worker } from "./http";
import { adminRoutes } from "./integrations/admin";
import type { IntegrationSelector } from "./integrations/types";
import { finishSpan, grantOrigin, parseTraceparent, startSpan } from "./observability/tracing";
import { alertOnTrip, tripRoleKey } from "./canaries/admin";
import { tripRequest } from "./canaries/alerts";

export { GrantRegistry };

const ttlSeconds = z.number().int().min(1).max(maxGrantTtlSeconds);

const issueRequest = z.strictObject({
  integrations: z.array(integrationId).min(1).max(16),
  ttlSeconds,
  label: grantLabel.optional(),
});

const renewRequest = z.strictObject({ ttlSeconds });

/**
 * Trace an authenticated request. Callers only reach this after authentication, so a trace parent
 * from an unauthenticated request is never honoured.
 */
async function traced(
  context: Context<Worker>,
  operation: "grant.list" | "grant.renew" | "status",
  work: () => Promise<Response>,
): Promise<Response> {
  const span = startSpan(
    context.env,
    (task) => context.executionCtx.waitUntil(task),
    operation,
    parseTraceparent(context.req.header("traceparent") ?? null),
  );

  let status = 503;

  try {
    const response = await work();
    status = response.status;

    return response;
  } finally {
    finishSpan(span, status);
  }
}

const app = new Hono<Worker>();

app.onError(() => failure(503, "broker_unavailable"));

app.route("/v1/admin", adminRoutes);

app.post("/v1/grants", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const request = context.req.raw;
  const principal = await orchestrator(request, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) {
    await tripRoleKey(context, "issuer-auth");

    return failure(401, "orchestrator_authentication_required");
  }

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

    const { integrations, ttlSeconds, label } = input.data;

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
        label,
        traceparent: grantOrigin(span, parent),
      },
      principal,
    );

    if (result.status === "forbidden") {
      status = 403;

      return failure(status, "integration_forbidden", false, {
        reason: result.reason,
        integrations: result.integrations,
      });
    }

    if (result.status === "ambiguous_github") {
      status = 400;

      return failure(status, "multiple_github_integrations");
    }

    if (result.status === "limit") {
      status = 429;

      return failure(status, "grant_limit");
    }

    status = 201;

    return privateJson(
      {
        id,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        integrations,
        kinds: result.kinds,
      },
      status,
    );
  } finally {
    finishSpan(span, status);
  }
});

app.get("/v1/status", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const request = context.req.raw;
  const limits = { maxGrantTtlSeconds };

  if (await administrator(request, context.env.BROKER_ADMIN_KEY)) {
    managementKeyring(context.env);

    return traced(context, "status", async () =>
      privateJson({
        apiVersion,
        role: "admin",
        limits,
        counts: await registry(context.env).counts(),
      }),
    );
  }

  const principal = await orchestrator(request, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) {
    await tripRoleKey(context, "issuer-auth");

    return failure(401, "authentication_required");
  }

  return traced(context, "status", async () =>
    privateJson({
      apiVersion,
      role: principal.owner === "broker-api-key" ? "issuer" : "github-actions",
      limits,
    }),
  );
});

app.get("/v1/grants", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const principal = await orchestrator(context.req.raw, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) {
    await tripRoleKey(context, "issuer-auth");

    return failure(401, "orchestrator_authentication_required");
  }

  return traced(context, "grant.list", async () => {
    const grants = await registry(context.env).listGrants(principal.owner);

    return privateJson({ grants: grants.map((grant) => grantView(grant, false)) });
  });
});

app.post("/v1/grants/:id/renew", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const request = context.req.raw;
  const principal = await orchestrator(request, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) {
    await tripRoleKey(context, "issuer-auth");

    return failure(401, "orchestrator_authentication_required");
  }

  return traced(context, "grant.renew", async () => {
    const id = context.req.param("id");
    const input = renewRequest.safeParse(await readJson(request, 1_024));

    if (!grantIdPattern.test(id) || !input.success) return failure(400, "invalid_grant_request");

    const result = await registry(context.env).renew(
      id,
      principal.owner,
      Date.now() + input.data.ttlSeconds * 1_000,
      tripRequest(request, "renew"),
    );

    if (result.status === "not_found") {
      alertOnTrip(context, result.trip);

      return failure(404, "grant_not_found");
    }

    return privateJson(grantView(result.grant, false));
  });
});

app.delete("/v1/grants/:id", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG ?? "{}");
  const principal = await orchestrator(context.req.raw, config, context.env.BROKER_ISSUER_KEY);

  if (!principal) {
    await tripRoleKey(context, "issuer-auth");

    return failure(401, "orchestrator_authentication_required");
  }

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

    alertOnTrip(
      context,
      await registry(context.env).revoke(
        id,
        principal.owner,
        tripRequest(context.req.raw, "revoke"),
      ),
    );
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
    parseConfig(context.env.BROKER_CONFIG ?? "{}").limits ?? {},
    tripRequest(
      request,
      incoming.type === "gateway" ? "gateway" : incoming.type === "git" ? "git" : "github-api",
      incoming.type === "gateway" ? incoming.id : "",
      token,
    ),
  );

  if (authorized.status === "invalid") {
    alertOnTrip(context, authorized.trip);

    return failure(401, "grant_invalid", isGit);
  }

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

  let renewal: ReturnType<typeof setInterval> | undefined;

  const complete = (status: number, failed?: boolean) => {
    if (completed) return;
    completed = true;
    clearInterval(renewal);
    finishSpan(span, status, failed);
    // A lost release holds a slot until the lease expires. It never widens access.
    context.executionCtx.waitUntil(store.release(authorized.leaseId).catch(() => {}));
  };

  const { integration } = authorized;
  const target = upstreamRoute(incoming, integration);

  const path = decodedPath(requestUrl.pathname);

  const blockedEndpoint =
    target?.type === "http" &&
    (request.headers.has("upgrade") ||
      path === undefined ||
      path.includes(token) ||
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

  renewal = setInterval(() => {
    context.executionCtx.waitUntil(store.renewLease(authorized.leaseId).catch(() => {}));
  }, leaseTtlMs / 3);

  try {
    const response = await upstream(request, target, credential, token);

    return withCompletion(response, (failed) => complete(response.status, failed));
  } catch {
    complete(502);

    return failure(502, "upstream_unavailable");
  }
});

function decodedPath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

export default app;
