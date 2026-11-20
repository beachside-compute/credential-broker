import type { BrokerConfig } from "../config";
import { bearer } from "../grants/tokens";
import { matchesKey } from "./api-key";
import { githubActionsPrincipal } from "./github-oidc";

export interface Principal {
  owner: string;
  integrations?: string[];
}

export interface RoleBindings {
  BROKER_ADMIN_KEY?: string;
  BROKER_ISSUER_KEY?: string;
}

export function assertSeparateRoleKeys(
  bindings: RoleBindings,
  encryptionKeys: Iterable<string>,
): void {
  const { BROKER_ADMIN_KEY: admin, BROKER_ISSUER_KEY: issuer } = bindings;

  if (admin && admin === issuer)
    throw new Error("Broker administration and issuance keys must differ");

  for (const key of encryptionKeys) {
    if (key === admin || key === issuer)
      throw new Error("Broker role keys must differ from encryption keys");
  }
}

export async function administrator(request: Request, key: string | undefined): Promise<boolean> {
  const token = authenticationToken(request);

  return token ? matchesKey(key, token) : false;
}

export async function orchestrator(
  request: Request,
  config: BrokerConfig,
  apiKey: string | undefined,
): Promise<Principal | undefined> {
  const token = authenticationToken(request);

  if (!token) return;

  if (await matchesKey(apiKey, token)) return { owner: "broker-api-key" };

  return githubActionsPrincipal(token, config);
}

function authenticationToken(request: Request): string | undefined {
  const token = bearer(request.headers.get("authorization"));

  return token && token.length <= 8192 ? token : undefined;
}
