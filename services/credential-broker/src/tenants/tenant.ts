import { administrator, authenticationToken, orchestrator } from "../auth";
import { githubActionsPrincipal } from "../auth/github-oidc";
import type { Principal } from "../auth";
import { parseConfig } from "../config";
import type { BrokerConfig } from "../config";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { GrantRegistry } from "../grants/registry";
import { tokenHash } from "../grants/tokens";
import type { Env } from "../http";
import { rootKeyring, unwrapDataKey } from "./data-key";
import type { TenantDirectory } from "./directory";
import type { TenantHostBindings } from "./hosts";
import { defaultTenant } from "./identity";
import type { TenantRole } from "./identity";
import { matchesRoleFormat } from "./role-keys";
import type { RoleBindings } from "./role-keys";

export interface TenantBindings extends RoleBindings, TenantHostBindings {
  BROKER_CONFIG?: string;
  REGISTRY: DurableObjectNamespace<GrantRegistry>;
  DIRECTORY: DurableObjectNamespace<TenantDirectory>;
}

export interface Tenant {
  id: string;
  store: DurableObjectStub<GrantRegistry>;
  config(): Promise<BrokerConfig>;
  keyring(): Promise<EncryptionKeyring>;
  administrator(request: Request): Promise<boolean>;
  orchestrator(request: Request): Promise<Principal | undefined>;
  hasIssuerKey(): Promise<boolean>;
}

const keyrings = new WeakMap<
  TenantBindings["REGISTRY"],
  Map<string, { expires: number; keyring: EncryptionKeyring }>
>();

export function tenantStore(env: Env, id: string) {
  return env.REGISTRY.getByName(id === defaultTenant ? "grant-registry" : `tenant/${id}`);
}

function hostedTenant(env: Env, id: string): Tenant {
  const store = tenantStore(env, id);
  let config: Promise<BrokerConfig> | undefined;

  const getConfig = () =>
    (config ??= store.storedConfig().then((data) => ({
      ...data,
      workerSecretBindings: [],
    })));

  const matchesRole = async (token: string, role: TenantRole) =>
    matchesRoleFormat(role, token) && (await store.role(await tokenHash(token))) === role;

  return {
    id,
    store,
    config: getConfig,
    keyring: () => hostedKeyring(env, id, store),
    async administrator(request) {
      const token = authenticationToken(request);

      return Boolean(token && (await matchesRole(token, "admin")));
    },
    async orchestrator(request) {
      const token = authenticationToken(request);

      if (!token) return;

      if (await matchesRole(token, "issuer")) return { owner: "broker-api-key" };

      return githubActionsPrincipal(token, await getConfig());
    },
    hasIssuerKey: () => store.hasRoleKey("issuer"),
  };
}

function builtInTenant(env: Env): Tenant {
  let store: DurableObjectStub<GrantRegistry> | undefined;
  let config: BrokerConfig | undefined;
  const getConfig = async () => (config ??= parseConfig(env.BROKER_CONFIG ?? "{}"));

  return {
    id: defaultTenant,
    get store() {
      return (store ??= tenantStore(env, defaultTenant));
    },
    config: getConfig,
    async keyring() {
      return rootKeyring(env);
    },
    administrator: (request) => administrator(request, env.BROKER_ADMIN_KEY),
    async orchestrator(request) {
      return orchestrator(request, await getConfig(), env.BROKER_ISSUER_KEY);
    },
    async hasIssuerKey() {
      return Boolean(env.BROKER_ISSUER_KEY);
    },
  };
}

export function tenantFor(env: Env, id: string): Tenant {
  return id === defaultTenant ? builtInTenant(env) : hostedTenant(env, id);
}

async function hostedKeyring(
  env: Env,
  id: string,
  store: Tenant["store"],
): Promise<EncryptionKeyring> {
  const root = rootKeyring(env);
  let cache = keyrings.get(env.REGISTRY);

  if (!cache) {
    cache = new Map();
    keyrings.set(env.REGISTRY, cache);
  }

  const cached = cache.get(id);
  const now = Date.now();

  if (cached && cached.expires > now) return cached.keyring;

  const { active, keys } = await store.dataKeys();

  const unwrapped = await Promise.all(
    keys.map(
      async ({ version, wrapped }) => [version, await unwrapDataKey(wrapped, id, root)] as const,
    ),
  );

  const keyring = { active, keys: new Map(unwrapped) };

  if (!keyring.keys.has(active)) throw new Error("Tenant encryption key unavailable");

  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(id, { expires: now + 300_000, keyring });

  return keyring;
}
