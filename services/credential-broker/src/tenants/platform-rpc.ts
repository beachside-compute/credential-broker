import { WorkerEntrypoint } from "cloudflare:workers";
import type { z } from "zod";
import type { Env } from "../http";
import {
  auditInput,
  eraseTenant,
  idInput,
  inspectTenant,
  listTenants,
  pageInput,
  platformAuditLog,
  provisionTenant,
  rewrapTenantKeys,
  rotateTenantRoleKey,
  roleInput,
  stateInput,
  setTenantStatus,
} from "./platform-operations";
import { rotateTenantDataKey } from "./rotate-data-key";

export class PlatformControl extends WorkerEntrypoint<Env> {
  provision(request: z.input<typeof idInput>) {
    return provisionTenant(this.env, "control-binding", request);
  }

  list(request: z.input<typeof pageInput> = {}) {
    return listTenants(this.env, request);
  }

  inspect(request: z.input<typeof idInput>) {
    return inspectTenant(this.env, request);
  }
}

export class PlatformOperator extends WorkerEntrypoint<Env> {
  setStatus(request: z.input<typeof stateInput>) {
    return setTenantStatus(this.env, "operator-binding", request);
  }

  rotateRoleKey(request: z.input<typeof roleInput>) {
    return rotateTenantRoleKey(this.env, "operator-binding", request);
  }

  rewrap(request: z.input<typeof idInput>) {
    return rewrapTenantKeys(this.env, "operator-binding", request);
  }

  rotateDataKey(request: z.input<typeof idInput>) {
    return rotateTenantDataKey(this.env, "operator-binding", request);
  }

  erase(request: z.input<typeof idInput>) {
    return eraseTenant(this.env, "operator-binding", request);
  }

  auditLog(request: z.input<typeof auditInput> = {}) {
    return platformAuditLog(this.env, request);
  }
}
