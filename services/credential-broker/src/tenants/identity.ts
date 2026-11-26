import { z } from "zod";

export const defaultTenant = "default";

export const tenantId = z.string().regex(/^[a-z0-9]{8,32}$/);

export const tenantRole = z.enum(["admin", "issuer"]);

export type TenantRole = z.infer<typeof tenantRole>;
