import type { BrokerConfig } from "../config";
import { bearer } from "../grants/tokens";
import { matchesKey } from "./api-key";
import { githubActionsPrincipal } from "./github-oidc";

export interface Principal {
  owner: string;
  integrations?: string[];
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

export function authenticationToken(request: Request): string | undefined {
  const token = bearer(request.headers.get("authorization"));

  return token && token.length <= 8192 ? token : undefined;
}
