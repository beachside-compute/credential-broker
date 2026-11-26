import { z } from "zod";
import { tokenHash } from "../grants/tokens";
import type { Env } from "../http";
import { localKeyService } from "./data-key";
import type { PlatformAction, PlatformActor, tenants } from "./directory-schema";
import { brokerHosts } from "./hosts";
import { initialTenantKeyVersion, tenantId, tenantRole } from "./identity";
import { invalidateActive, tenantDirectory } from "./resolve";
import { newRoleKey } from "./role-keys";
import { invalidateTenantKeyring, tenantStore } from "./tenant";

export const idInput = z.strictObject({ id: tenantId });

export const pageInput = z.strictObject({
  after: tenantId.optional(),
  limit: z.int().min(1).max(100).optional(),
});

export const stateInput = idInput.extend({ status: z.enum(["active", "suspended"]) });

export const roleInput = idInput.extend({ role: tenantRole });

export const auditInput = z.strictObject({
  before: z.int().positive().optional(),
  limit: z.int().min(1).max(100).optional(),
  tenant: tenantId.optional(),
});

export interface PlatformErrorRecord {
  kind: "integration" | "alert_destination";
  id: string;
}

export class PlatformError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    readonly record?: PlatformErrorRecord,
  ) {
    super(record ? `${code}: ${record.kind} ${record.id}` : code);
  }
}

function input<S extends z.ZodType, Value>(
  schema: S,
  value: Value,
  code: string,
  status: 400 | 404 = 400,
): z.output<S> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new PlatformError(status, code);

  return parsed.data;
}

function tenantNotFound(): never {
  throw new PlatformError(404, "tenant_not_found");
}

function tenantView(row: typeof tenants.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    ...(row.deleting && { deleting: true }),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function provisionTenant(
  env: Env,
  actor: PlatformActor,
  request: z.input<typeof idInput>,
) {
  const { id } = input(idInput, request, "invalid_tenant");

  if (!brokerHosts(env).domain) throw new PlatformError(503, "tenant_domain_unconfigured");

  return auditOperation(env, actor, id, "provision", async () => {
    const adminKey = newRoleKey("admin");
    const issuerKey = newRoleKey("issuer");

    const [adminHash, issuerHash, dataKey] = await Promise.all([
      tokenHash(adminKey),
      tokenHash(issuerKey),
      localKeyService(env).generateDataKey({ tenant: id, version: initialTenantKeyVersion }),
    ]);

    if (!(await tenantDirectory(env).provision({ id, adminHash, issuerHash, dataKey })))
      throw new PlatformError(409, "tenant_exists");

    invalidateActive(env, id);
    invalidateTenantKeyring(env, id);

    return { id, adminKey, issuerKey };
  });
}

export async function listTenants(env: Env, request: z.input<typeof pageInput> = {}) {
  const { after, limit = 50 } = input(pageInput, request, "invalid_tenant_query");
  const entries = await tenantDirectory(env).list(after, limit + 1);
  const page = entries.slice(0, limit);

  return { tenants: page.map(tenantView), next: entries[limit] ? page.at(-1)!.id : null };
}

export async function inspectTenant(env: Env, request: z.input<typeof idInput>) {
  const { id } = input(idInput, request, "tenant_not_found", 404);
  const row = await tenantDirectory(env).lookup(id);

  if (!row) return tenantNotFound();

  const counts =
    !row.deleting && (row.status === "active" || row.status === "suspended")
      ? await tenantStore(env, id).counts()
      : undefined;

  return { ...tenantView(row), counts };
}

export async function setTenantStatus(
  env: Env,
  actor: PlatformActor,
  request: z.input<typeof stateInput>,
) {
  const { id } = input(idInput, { id: request?.id }, "tenant_not_found", 404);
  const { status } = input(stateInput, request, "invalid_tenant_status");

  return auditOperation(
    env,
    actor,
    id,
    status === "active" ? "reactivate" : "suspend",
    async () => {
      const row = await tenantDirectory(env).setStatus(id, status);

      if (!row) return tenantNotFound();
      invalidateActive(env, id);

      return tenantView(row);
    },
  );
}

export async function rotateTenantRoleKey(
  env: Env,
  actor: PlatformActor,
  request: z.input<typeof roleInput>,
) {
  const { id } = input(idInput, { id: request?.id }, "tenant_not_found", 404);
  const { role } = input(roleInput, request, "invalid_tenant_role");

  return auditOperation(
    env,
    actor,
    id,
    role === "admin" ? "rotate_admin" : "rotate_issuer",
    async () => {
      const key = newRoleKey(role);

      if (!(await tenantDirectory(env).rotate(id, role, await tokenHash(key))))
        return tenantNotFound();

      return { id, role, key };
    },
  );
}

export async function operableTenant(env: Env, id: string) {
  const row = await tenantDirectory(env).lookup(id);

  if (!row || row.deleting || (row.status !== "active" && row.status !== "suspended"))
    return tenantNotFound();

  return tenantStore(env, id);
}

export async function rewrapTenantKeys(
  env: Env,
  actor: PlatformActor,
  request: z.input<typeof idInput>,
) {
  const { id } = input(idInput, request, "tenant_not_found", 404);

  await auditOperation(env, actor, id, "rewrap", async () => {
    const store = await operableTenant(env, id);
    const { active, keys } = await store.dataKeys();

    if (!keys.some(({ version }) => version === active))
      throw new PlatformError(409, "tenant_key_changed");
    const keyService = localKeyService(env);

    for (const { version, wrapped: previous } of keys) {
      const wrapped = await keyService.rewrapDataKey(previous, { tenant: id, version });

      if (wrapped && !(await store.rewrapDataKeys(version, previous, wrapped)))
        throw new PlatformError(409, "tenant_key_changed");
    }

    invalidateTenantKeyring(env, id);
  });
}

export async function eraseTenant(
  env: Env,
  actor: PlatformActor,
  request: z.input<typeof idInput>,
) {
  const { id } = input(idInput, request, "tenant_not_found", 404);

  await auditOperation(env, actor, id, "erase", async () => {
    const erased = await tenantDirectory(env).erase(id);
    invalidateActive(env, id);
    invalidateTenantKeyring(env, id);

    if (!erased) return tenantNotFound();
  });
}

export async function platformAuditLog(env: Env, request: z.input<typeof auditInput> = {}) {
  const { before, limit = 50, tenant } = input(auditInput, request, "invalid_audit_query");
  const rows = await tenantDirectory(env).auditLog(before, limit + 1, tenant);
  const page = rows.slice(0, limit);
  const cutoff = Date.now() - 5 * 60_000;

  return {
    records: page.map((row) => ({
      ...row,
      completion: row.outcome ? "recorded" : row.startedAt < cutoff ? "unconfirmed" : "pending",
    })),
    next: rows[limit] ? page.at(-1)!.id : null,
  };
}

async function finishAudit(env: Env, id: number, result: "ok" | "failed") {
  try {
    await tenantDirectory(env).finishAudit(id, result);
  } catch {
    try {
      await tenantDirectory(env).finishAudit(id, result);
    } catch {
      console.error(JSON.stringify({ event: "platform_audit_completion_failed", auditId: id }));
    }
  }
}

export async function auditOperation<T>(
  env: Env,
  actor: PlatformActor,
  tenant: string,
  operation: PlatformAction,
  work: () => Promise<T>,
): Promise<T> {
  const directory = tenantDirectory(env);
  const id = await directory.startAudit({ actor, tenant, operation });
  let result: "ok" | "failed" = "failed";

  try {
    const value = await work();
    result = "ok";

    return value;
  } finally {
    await finishAudit(env, id, result);
  }
}
