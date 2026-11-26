import { z } from "zod";
import { defaultTenant, tenantId } from "./identity";

const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export const tenantDomain = hostname.max(220);

export const brokerAliases = z.array(hostname).max(32);

export interface TenantHostBindings {
  BROKER_TENANT_DOMAIN?: string;
  BROKER_HOST_ALIASES?: string;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function requestTenant(bindings: TenantHostBindings, url: string): string | undefined {
  const domain = bindings.BROKER_TENANT_DOMAIN;
  const host = normalizedHost(new URL(url).hostname);

  if (!domain || !host.endsWith(`.${domain}`)) return defaultTenant;

  const id = tenantId.safeParse(host.slice(0, -domain.length - 1));

  return id.data;
}

export function isBrokerHost(bindings: TenantHostBindings, requestUrl: string, destination: URL) {
  const host = normalizedHost(destination.hostname);
  const domain = bindings.BROKER_TENANT_DOMAIN;
  const aliases = brokerAliases.safeParse(bindings.BROKER_HOST_ALIASES?.split(",") ?? []);

  return (
    host === normalizedHost(new URL(requestUrl).hostname) ||
    host === domain ||
    Boolean(domain && host.endsWith(`.${domain}`)) ||
    !aliases.success ||
    aliases.data.includes(host)
  );
}
