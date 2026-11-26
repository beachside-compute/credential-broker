import type { Context } from "hono";
import type { Env, Worker } from "../http";
import { requestTenant } from "./hosts";
import { defaultTenant } from "./identity";
import { tenantFor } from "./tenant";
import type { Tenant } from "./tenant";

const active = new WeakMap<Env["DIRECTORY"], Map<string, number>>();

export function tenantDirectory(env: Env) {
  return env.DIRECTORY.getByName("tenant-directory");
}

export function invalidateActive(env: Env, id: string) {
  active.get(env.DIRECTORY)?.delete(id);
}

async function isActive(env: Env, id: string): Promise<boolean> {
  let cache = active.get(env.DIRECTORY);

  if (!cache) {
    cache = new Map();
    active.set(env.DIRECTORY, cache);
  }

  const now = Date.now();

  if ((cache.get(id) ?? 0) > now) return true;

  cache.delete(id);

  if (!(await tenantDirectory(env).active(id))) return false;

  if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
  cache.set(id, now + 30_000);

  return true;
}

export async function resolveTenant<E extends Worker>(
  context: Context<E>,
): Promise<Tenant | undefined> {
  const { env } = context;
  const id = requestTenant(env, context.req.url);

  if (!id || (id !== defaultTenant && (!env.BROKER_PLATFORM_KEY || !(await isActive(env, id)))))
    return;

  const tenant = tenantFor(env, id);
  context.set("tenant", tenant);

  return tenant;
}
