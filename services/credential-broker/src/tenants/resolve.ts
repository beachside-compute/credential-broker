import type { Context } from "hono";
import type { Env, Worker } from "../http";
import { requestTenant } from "./hosts";
import { defaultTenant } from "./identity";
import { tenantFor } from "./tenant";
import type { Tenant } from "./tenant";

const active = new WeakMap<Env["DIRECTORY"], Map<string, number>>();

const inactive = new WeakMap<Env["DIRECTORY"], Map<string, number>>();

export function tenantDirectory(env: Env) {
  return env.DIRECTORY.getByName("tenant-directory");
}

export function invalidateActive(env: Env, id: string) {
  active.get(env.DIRECTORY)?.delete(id);
  inactive.get(env.DIRECTORY)?.delete(id);
}

async function isActive(env: Env, id: string): Promise<boolean> {
  const now = Date.now();

  if ((active.get(env.DIRECTORY)?.get(id) ?? 0) > now) return true;

  if ((inactive.get(env.DIRECTORY)?.get(id) ?? 0) > now) return false;

  const found = await tenantDirectory(env).active(id);
  const entries = found ? active : inactive;
  let cache = entries.get(env.DIRECTORY);

  if (!cache) {
    cache = new Map();
    entries.set(env.DIRECTORY, cache);
  }

  cache.delete(id);

  if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
  cache.set(id, now + (found ? 30_000 : 2_000));

  return found;
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
