import { administrator, authenticationToken, orchestrator } from "../auth";
import { githubActionsPrincipal } from "../auth/github-oidc";
import type { Principal } from "../auth";
import { trustedPrincipal } from "../auth/trusted-issuer";
import { parseConfig, tenantConfigFor } from "../config";
import type { BrokerConfig, TrustedIssuer } from "../config";
import { importDataKey } from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { GrantRegistry, TenantKeyState } from "../grants/registry";
import { tokenHash } from "../grants/tokens";
import type { Env } from "../http";
import { rootKeyring, unwrapDataKey } from "./data-key";
import type { TenantDirectory } from "./directory";
import { brokerHosts } from "./hosts";
import type { TenantHostBindings } from "./hosts";
import { defaultTenant } from "./identity";
import type { TenantRole } from "./identity";
import { matchesRoleFormat } from "./role-keys";
import type { RoleBindings } from "./role-keys";

export interface TenantBindings extends RoleBindings, TenantHostBindings {
  BROKER_CONFIG?: string;
  BROKER_PLATFORM_HTTP_ENABLED?: string;
  REGISTRY: DurableObjectNamespace<GrantRegistry>;
  DIRECTORY: DurableObjectNamespace<TenantDirectory>;
}

export interface Tenant {
  id: string;
  store: DurableObjectStub<GrantRegistry>;
  config(): Promise<BrokerConfig>;
  keyring(state?: TenantKeyState | null): Promise<EncryptionKeyring>;
  administrator(request: Request): Promise<boolean>;
  orchestrator(request: Request): Promise<Principal | undefined>;
  hasIssuerKey(): Promise<boolean>;
  trustedIssuers(): TrustedIssuer[];
}

const keyrings = new WeakMap<
  TenantBindings["REGISTRY"],
  Map<string, { expires: number; fingerprint: string; keyring: EncryptionKeyring<CryptoKey> }>
>();

export function tenantStore(env: Env, id: string) {
  return env.REGISTRY.getByName(id === defaultTenant ? "grant-registry" : `tenant/${id}`);
}

function deploymentConfig(env: Env): BrokerConfig {
  return parseConfig(env.BROKER_CONFIG ?? "{}", Boolean(brokerHosts(env).domain));
}

function applicableIssuers(env: Env, id: string): TrustedIssuer[] {
  const entries = deploymentConfig(env).trustedIssuers ?? [];

  return entries.filter(({ tenant }) =>
    id === defaultTenant ? tenant !== undefined : tenant === undefined,
  );
}

async function trustedRole(
  env: Env,
  token: string,
  id: string,
  role: TenantRole,
  url: string,
): Promise<Principal | undefined> {
  if (!token.includes(".")) return;

  const audience =
    id === defaultTenant ? new URL(url).origin : `https://${brokerHosts(env).domain}`;

  return trustedPrincipal(token, applicableIssuers(env, id), id, role, audience);
}

function hostedTenant(env: Env, id: string): Tenant {
  const store = tenantStore(env, id);
  let config: Promise<BrokerConfig> | undefined;

  const getConfig = () =>
    (config ??= store.storedConfig().then((data) => ({
      ...tenantConfigFor(id).parse(data),
      workerSecretBindings: [],
    })));

  const matchesRole = async (token: string, role: TenantRole) =>
    matchesRoleFormat(role, token) && (await store.role(await tokenHash(token))) === role;

  return {
    id,
    store,
    config: getConfig,
    async keyring(state) {
      if (state === null) throw new Error("Tenant encryption key unavailable");

      return hostedKeyring(env, id, state ?? (await store.dataKeys()));
    },
    async administrator(request) {
      const token = authenticationToken(request);

      return Boolean(
        token &&
        ((await matchesRole(token, "admin")) ||
          (await trustedRole(env, token, id, "admin", request.url))),
      );
    },
    async orchestrator(request) {
      const token = authenticationToken(request);

      if (!token) return;

      if (await matchesRole(token, "issuer")) return { kind: "api-key", owner: "broker-api-key" };

      return (
        (await trustedRole(env, token, id, "issuer", request.url)) ??
        githubActionsPrincipal(token, await getConfig())
      );
    },
    hasIssuerKey: () => store.hasRoleKey("issuer"),
    trustedIssuers: () => applicableIssuers(env, id),
  };
}

function builtInTenant(env: Env): Tenant {
  let store: DurableObjectStub<GrantRegistry> | undefined;
  let config: BrokerConfig | undefined;
  const getConfig = async () => (config ??= deploymentConfig(env));

  return {
    id: defaultTenant,
    get store() {
      return (store ??= tenantStore(env, defaultTenant));
    },
    config: getConfig,
    async keyring() {
      return rootKeyring(env);
    },
    async administrator(request) {
      if (await administrator(request, env.BROKER_ADMIN_KEY)) return true;

      const token = authenticationToken(request);

      return Boolean(token && (await trustedRole(env, token, defaultTenant, "admin", request.url)));
    },
    async orchestrator(request) {
      const config = await getConfig();
      const token = authenticationToken(request);

      return (
        (token && (await trustedRole(env, token, defaultTenant, "issuer", request.url))) ||
        orchestrator(request, config, env.BROKER_ISSUER_KEY)
      );
    },
    async hasIssuerKey() {
      return Boolean(env.BROKER_ISSUER_KEY);
    },
    trustedIssuers: () => applicableIssuers(env, defaultTenant),
  };
}

export function tenantFor(env: Env, id: string): Tenant {
  return id === defaultTenant ? builtInTenant(env) : hostedTenant(env, id);
}

export function invalidateTenantKeyring(env: Env, id: string) {
  keyrings.get(env.REGISTRY)?.delete(id);
}

async function hostedKeyring(
  env: Env,
  id: string,
  { active, keys }: TenantKeyState,
): Promise<EncryptionKeyring> {
  const root = rootKeyring(env);
  let cache = keyrings.get(env.REGISTRY);

  if (!cache) {
    cache = new Map();
    keyrings.set(env.REGISTRY, cache);
  }

  const now = Date.now();

  for (const [tenant, entry] of cache) if (entry.expires <= now) cache.delete(tenant);

  const fingerprint = JSON.stringify([
    active,
    keys.map(({ version, wrapped }) => [
      version,
      wrapped.keyVersion,
      wrapped.nonce,
      wrapped.ciphertext,
    ]),
  ]);

  const cached = cache.get(id);

  if (cached?.fingerprint === fingerprint) return cached.keyring;
  cache.delete(id);

  const unwrapped = await Promise.allSettled(
    keys.map(
      async ({ version, wrapped }) =>
        [version, await importDataKey(await unwrapDataKey(wrapped, id, root, version))] as const,
    ),
  );

  const keyring = {
    active,
    keys: new Map(
      unwrapped.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ),
  };

  if (!keyring.keys.has(active)) throw new Error("Tenant encryption key unavailable");

  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(id, { expires: now + 300_000, fingerprint, keyring });

  return keyring;
}
