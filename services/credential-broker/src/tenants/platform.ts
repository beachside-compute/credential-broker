import { Hono } from "hono";
import { z } from "zod";
import { authenticationToken } from "../auth";
import { matchesKey } from "../auth/api-key";
import { tripRoleKey } from "../canaries/admin";
import { privateJson, privateNoContent, readJson } from "../http";
import type { Worker } from "../http";
import { rootKeyring } from "./data-key";
import { tenantId, tenantRole } from "./identity";
import {
  eraseTenant,
  inspectTenant,
  listTenants,
  pageInput,
  PlatformError,
  provisionTenant,
  rewrapTenantKeys,
  rotateTenantRoleKey,
  setTenantStatus,
  stateInput,
} from "./platform-operations";
import { rotateTenantDataKey } from "./rotate-data-key";
import { resolveTenant } from "./resolve";

type PlatformWorker = Worker & { Variables: { platformRole: "control" | "operator" } };

const patchInput = stateInput.omit({ id: true });

const listInput = pageInput.extend({
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(pageInput.shape.limit.unwrap())
    .optional(),
});

export const platformRoutes = new Hono<PlatformWorker>();

platformRoutes.onError((error) => {
  if (error instanceof PlatformError)
    return privateJson({ error: error.code, ...(error.record && { record: error.record }) }, error.status);

  console.error(JSON.stringify({ event: "platform_operation_failed" }));

  return privateJson({ error: "broker_unavailable" }, 503);
});

platformRoutes.use("*", async (context, next) => {
  const { env } = context;

  if (env.BROKER_PLATFORM_HTTP_ENABLED !== "true")
    return privateJson({ error: "unsupported_route" }, 404);

  const token = authenticationToken(context.req.raw);

  const [control, operator] = token
    ? await Promise.all([
        matchesKey(env.BROKER_PLATFORM_KEY, token),
        matchesKey(env.BROKER_PLATFORM_OPERATOR_KEY, token),
      ])
    : [false, false];

  if (!control && !operator) {
    if (token?.startsWith("bsg_")) {
      const tenant = await resolveTenant(context);

      if (tenant) await tripRoleKey(context, tenant, "platform-auth");
    }

    return privateJson({ error: "platform_authentication_required" }, 401);
  }

  rootKeyring(env);
  context.set("platformRole", operator ? "operator" : "control");
  await next();
});

platformRoutes.post("/tenants", async (context) => {
  if (context.get("platformRole") !== "control") return denied("control");

  return privateJson(
    await provisionTenant(context.env, "control-http", await readJson(context.req.raw, 1024)),
    201,
  );
});

platformRoutes.get("/tenants", async (context) => {
  if (context.get("platformRole") !== "control") return denied("control");

  const query = listInput.safeParse(context.req.query());

  if (!query.success) return privateJson({ error: "invalid_tenant_query" }, 400);

  return privateJson(await listTenants(context.env, query.data));
});

platformRoutes.get("/tenants/:id", async (context) => {
  if (context.get("platformRole") !== "control") return denied("control");

  return privateJson(await inspectTenant(context.env, { id: context.req.param("id") }));
});

platformRoutes.patch("/tenants/:id", async (context) => {
  if (context.get("platformRole") !== "operator") return denied("operator");

  const id = tenantId.safeParse(context.req.param("id"));
  const patch = patchInput.safeParse(await readJson(context.req.raw, 1024));

  if (!id.success) return privateJson({ error: "tenant_not_found" }, 404);

  if (!patch.success) return privateJson({ error: "invalid_tenant_status" }, 400);

  return privateJson(
    await setTenantStatus(context.env, "operator-http", { id: id.data, ...patch.data }),
  );
});

platformRoutes.post("/tenants/:id/keys/:role/rotate", async (context) => {
  if (context.get("platformRole") !== "operator") return denied("operator");

  const id = tenantId.safeParse(context.req.param("id"));
  const role = tenantRole.safeParse(context.req.param("role"));

  if (!id.success) return privateJson({ error: "tenant_not_found" }, 404);

  if (!role.success) return privateJson({ error: "invalid_tenant_role" }, 400);

  return privateJson(
    await rotateTenantRoleKey(context.env, "operator-http", { id: id.data, role: role.data }),
  );
});

platformRoutes.post("/tenants/:id/rewrap", async (context) => {
  if (context.get("platformRole") !== "operator") return denied("operator");

  await rewrapTenantKeys(context.env, "operator-http", { id: context.req.param("id") });

  return privateNoContent();
});

platformRoutes.post("/tenants/:id/data-key/rotate", async (context) => {
  if (context.get("platformRole") !== "operator") return denied("operator");

  return privateJson(
    await rotateTenantDataKey(context.env, "operator-http", { id: context.req.param("id") }),
  );
});

platformRoutes.delete("/tenants/:id", async (context) => {
  if (context.get("platformRole") !== "operator") return denied("operator");

  await eraseTenant(context.env, "operator-http", { id: context.req.param("id") });

  return privateNoContent();
});

function denied(role: PlatformWorker["Variables"]["platformRole"]) {
  return privateJson({ error: `platform_${role}_required` }, 403);
}
