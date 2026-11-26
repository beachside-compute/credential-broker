import { administrator, orchestrator } from "../auth";
import type { Principal } from "../auth";
import { parseConfig } from "../config";
import type { BrokerConfig } from "../config";
import { encryptionKeyring } from "../credentials/sources/encrypted-store";
import type { EncryptionKeyring } from "../credentials/sources/encrypted-store";
import type { GrantRegistry } from "../grants/registry";
import type { Env } from "../http";
import { assertSeparateRoleKeys } from "./role-keys";
import type { RoleBindings } from "./role-keys";

export const defaultTenant = "default";

export interface TenantBindings extends RoleBindings {
  BROKER_CONFIG?: string;
  REGISTRY: DurableObjectNamespace<GrantRegistry>;
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

export function tenantFor(env: Env, id: typeof defaultTenant): Tenant;
export function tenantFor(env: Env, id: string): Tenant | undefined;
export function tenantFor(env: Env, id: string): Tenant | undefined {
  if (id !== defaultTenant) return;
  let store: DurableObjectStub<GrantRegistry> | undefined;
  let config: BrokerConfig | undefined;
  const getConfig = async () => (config ??= parseConfig(env.BROKER_CONFIG ?? "{}"));

  return {
    id,
    get store() {
      return (store ??= env.REGISTRY.getByName("grant-registry"));
    },
    config: getConfig,
    async keyring() {
      const keyring = encryptionKeyring(env);
      assertSeparateRoleKeys(env, keyring.keys.values());

      return keyring;
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
