import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../http";
import {
  eraseTenant,
  inspectTenant,
  listTenants,
  provisionTenant,
  rewrapTenantKeys,
  rotateTenantRoleKey,
  setTenantStatus,
} from "./platform-operations";
import { tenantDirectory } from "./resolve";
import type { TenantRole } from "./identity";

export class PlatformControl extends WorkerEntrypoint<Env> {
  provision(request: { id: string }) {
    return provisionTenant(this.env, request);
  }

  list(request: { after?: string; limit?: number } = {}) {
    return listTenants(this.env, request);
  }

  inspect(request: { id: string }) {
    return inspectTenant(this.env, request);
  }
}

export class PlatformOperator extends WorkerEntrypoint<Env> {
  setStatus(request: { id: string; status: "active" | "suspended" }) {
    return setTenantStatus(this.env, "operator-binding", request);
  }

  rotateRoleKey(request: { id: string; role: TenantRole }) {
    return rotateTenantRoleKey(this.env, "operator-binding", request);
  }

  rewrap(request: { id: string }) {
    return rewrapTenantKeys(this.env, "operator-binding", request);
  }

  erase(request: { id: string }) {
    return eraseTenant(this.env, "operator-binding", request);
  }

  auditLog() {
    return tenantDirectory(this.env).auditLog();
  }
}
