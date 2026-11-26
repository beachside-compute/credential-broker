import { Hono } from "hono";
import { z } from "zod";
import { authenticationToken } from "../auth";
import { matchesKey } from "../auth/api-key";
import { tripRoleKey } from "../canaries/admin";
import { tokenHash } from "../grants/tokens";
import { privateJson, privateNoContent, readJson } from "../http";
import type { Worker } from "../http";
import { newDataKey, rootKeyring, unwrapDataKey, wrapDataKey } from "./data-key";
import { brokerHosts } from "./hosts";
import { tenantId, tenantRole } from "./identity";
import { invalidateActive, resolveTenant, tenantDirectory } from "./resolve";
import { newRoleKey } from "./role-keys";
import { invalidateTenantKeyring, tenantStore } from "./tenant";

const createInput = z.strictObject({ id: tenantId });

const patchInput = z.strictObject({ status: z.enum(["active", "suspended"]) });

const listInput = z.strictObject({
  after: tenantId.optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().max(100))
    .optional(),
});

export const platformRoutes = new Hono<Worker>();

platformRoutes.use("*", async (context, next) => {
  const { env } = context;

  if (!env.BROKER_PLATFORM_KEY) return privateJson({ error: "unsupported_route" }, 404);
  const token = authenticationToken(context.req.raw);

  if (!token || !(await matchesKey(env.BROKER_PLATFORM_KEY, token))) {
    if (token?.startsWith("bsg_")) {
      const tenant = await resolveTenant(context);

      if (tenant) await tripRoleKey(context, tenant, "platform-auth");
    }

    return privateJson({ error: "platform_authentication_required" }, 401);
  }

  rootKeyring(env);

  if (!brokerHosts(env).domain) return privateJson({ error: "broker_unavailable" }, 503);
  await next();
});

platformRoutes.post("/tenants", async (context) => {
  const input = createInput.safeParse(await readJson(context.req.raw, 1024));

  if (!input.success) return privateJson({ error: "invalid_tenant" }, 400);

  const { env } = context;
  const { id } = input.data;
  const adminKey = newRoleKey("admin");
  const issuerKey = newRoleKey("issuer");

  const [adminHash, issuerHash, dataKey] = await Promise.all([
    tokenHash(adminKey),
    tokenHash(issuerKey),
    wrapDataKey(newDataKey(), id, rootKeyring(env)),
  ]);

  const created = await tenantDirectory(env).provision({ id, adminHash, issuerHash, dataKey });

  if (created) {
    invalidateActive(env, id);
    invalidateTenantKeyring(env, id);
  }

  return created
    ? privateJson({ id, adminKey, issuerKey }, 201)
    : privateJson({ error: "tenant_exists" }, 409);
});

platformRoutes.get("/tenants", async (context) => {
  const query = listInput.safeParse(context.req.query());

  if (!query.success) return privateJson({ error: "invalid_tenant_query" }, 400);

  const { after, limit = 50 } = query.data;
  const entries = await tenantDirectory(context.env).list(after, limit + 1);
  const page = entries.slice(0, limit);

  return privateJson({
    tenants: page.map(tenantView),
    next: entries[limit] ? page.at(-1)?.id : null,
  });
});

platformRoutes.get("/tenants/:id", async (context) => {
  const id = tenantId.safeParse(context.req.param("id"));

  if (!id.success) return tenantNotFound();

  const row = await tenantDirectory(context.env).lookup(id.data);

  if (!row) return tenantNotFound();

  const counts =
    !row.deleting && (row.status === "active" || row.status === "suspended")
      ? await tenantStore(context.env, id.data).counts()
      : undefined;

  return privateJson({ ...tenantView(row), counts });
});

platformRoutes.patch("/tenants/:id", async (context) => {
  const id = tenantId.safeParse(context.req.param("id"));

  if (!id.success) return tenantNotFound();
  const patch = patchInput.safeParse(await readJson(context.req.raw, 1024));

  if (!patch.success) return privateJson({ error: "invalid_tenant_status" }, 400);

  const { env } = context;
  const row = await tenantDirectory(env).setStatus(id.data, patch.data.status);

  if (!row) return tenantNotFound();
  invalidateActive(env, id.data);

  return privateJson(tenantView(row));
});

platformRoutes.post("/tenants/:id/keys/:role/rotate", async (context) => {
  const id = tenantId.safeParse(context.req.param("id"));

  if (!id.success) return tenantNotFound();
  const role = tenantRole.safeParse(context.req.param("role"));

  if (!role.success) return privateJson({ error: "invalid_tenant_role" }, 400);

  const key = newRoleKey(role.data);

  const rotated = await tenantDirectory(context.env).rotate(
    id.data,
    role.data,
    await tokenHash(key),
  );

  return rotated ? privateJson({ id: id.data, role: role.data, key }) : tenantNotFound();
});

platformRoutes.post("/tenants/:id/rewrap", async (context) => {
  const id = tenantId.safeParse(context.req.param("id"));

  if (!id.success) return tenantNotFound();

  const { env } = context;
  const row = await tenantDirectory(env).lookup(id.data);

  if (!row || row.deleting || (row.status !== "active" && row.status !== "suspended"))
    return tenantNotFound();

  const store = tenantStore(env, id.data);
  const { active, keys } = await store.dataKeys();
  const previous = keys.find(({ version }) => version === active)?.wrapped;

  if (!previous) return tenantNotFound();

  const root = rootKeyring(env);

  if (previous.keyVersion === root.active) return privateNoContent();

  const key = await unwrapDataKey(previous, id.data, root);
  const wrapped = await wrapDataKey(key, id.data, root);

  if (!(await store.rewrapDataKeys(previous, wrapped)))
    return privateJson({ error: "tenant_key_changed" }, 409);

  invalidateTenantKeyring(env, id.data);

  return privateNoContent();
});

platformRoutes.delete("/tenants/:id", async (context) => {
  const id = tenantId.safeParse(context.req.param("id"));

  if (!id.success) return tenantNotFound();

  const { env } = context;
  const erased = await tenantDirectory(env).erase(id.data);
  invalidateActive(env, id.data);
  invalidateTenantKeyring(env, id.data);

  return erased ? privateNoContent() : tenantNotFound();
});

function tenantNotFound() {
  return privateJson({ error: "tenant_not_found" }, 404);
}

function tenantView(row: {
  id: string;
  status: string;
  deleting: boolean;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: row.id,
    status: row.status,
    ...(row.deleting && { deleting: true }),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
