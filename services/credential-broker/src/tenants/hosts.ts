import { z } from "zod";
import { defaultTenant, tenantId } from "./identity";

const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export const tenantDomain = hostname.max(220);

const brokerAliases = z.array(hostname).max(32);

export const wranglerHostConfig = z.object({
  vars: z
    .object({
      BROKER_TENANT_DOMAIN: z.string().optional(),
      BROKER_HOST_ALIASES: z.string().optional(),
      BROKER_PLATFORM_HTTP_ENABLED: z.enum(["true", "false"]).optional(),
    })
    .optional(),
});

export interface TenantHostBindings {
  BROKER_TENANT_DOMAIN?: string;
  BROKER_HOST_ALIASES?: string;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function brokerHosts(bindings: TenantHostBindings) {
  const domain = tenantDomain.optional().safeParse(bindings.BROKER_TENANT_DOMAIN);

  const aliases = brokerAliases.safeParse(
    (bindings.BROKER_HOST_ALIASES ?? "")
      .split(",")
      .map((value) => normalizedHost(value.trim()))
      .filter(Boolean),
  );

  if (
    !domain.success ||
    !aliases.success ||
    (domain.data && aliases.data.some((host) => host.endsWith(`.${domain.data}`)))
  )
    throw new Error("Invalid broker hostname configuration");

  return { domain: domain.data, aliases: aliases.data };
}

export function requestTenant(bindings: TenantHostBindings, url: string): string | undefined {
  const { domain, aliases } = brokerHosts(bindings);
  const host = normalizedHost(new URL(url).hostname);

  if (!domain || host === domain || aliases.includes(host)) return defaultTenant;

  if (!host.endsWith(`.${domain}`)) return;

  return tenantId.safeParse(host.slice(0, -domain.length - 1)).data;
}

export function isBrokerHost(bindings: TenantHostBindings, requestUrl: string, destination: URL) {
  const host = normalizedHost(destination.hostname);
  const { domain, aliases } = brokerHosts(bindings);

  return (
    host === normalizedHost(new URL(requestUrl).hostname) ||
    host === domain ||
    Boolean(domain && host.endsWith(`.${domain}`)) ||
    aliases.includes(host)
  );
}
