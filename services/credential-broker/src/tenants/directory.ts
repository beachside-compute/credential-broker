import { DurableObject } from "cloudflare:workers";
import { asc, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle-directory/migrations";
import type { TenantProvision } from "../grants/registry";
import type { Env } from "../http";
import { platformAudit, tenants } from "./directory-schema";
import type { TenantRole } from "./identity";

type TenantRow = typeof tenants.$inferSelect;

type AvailableStatus = Extract<TenantRow["status"], "active" | "suspended">;

export class TenantDirectory extends DurableObject<Env> {
  private readonly db;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  active(id: string): boolean {
    return this.lookup(id)?.status === "active";
  }

  lookup(id: string) {
    return this.db.select().from(tenants).where(eq(tenants.id, id)).get();
  }

  list(after: string | undefined, limit: number) {
    return this.db
      .select()
      .from(tenants)
      .where(after ? gt(tenants.id, after) : undefined)
      .orderBy(asc(tenants.id))
      .limit(limit)
      .all();
  }

  provision(input: TenantProvision): Promise<boolean> {
    return this.serial(input.id, async () => {
      const { id } = input;
      const existing = this.lookup(id);

      if (existing && existing.status !== "provisioning") return false;
      const now = Date.now();

      this.db
        .insert(tenants)
        .values({
          id,
          status: "provisioning",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      await this.registry(id).provision(input);
      this.writeStatus(id, "active");

      return true;
    });
  }

  setStatus(id: string, status: AvailableStatus): Promise<TenantRow | undefined> {
    return this.serial(id, async () => {
      const row = this.lookup(id);

      if (!row || !this.operable(row)) return;

      return this.writeStatus(id, status);
    });
  }

  rotate(id: string, role: TenantRole, hash: string): Promise<boolean> {
    return this.serial(id, async () => {
      const row = this.lookup(id);

      if (!row || !this.operable(row)) return false;
      await this.registry(id).setRoleKey(role, hash);

      return true;
    });
  }

  erase(id: string): Promise<boolean> {
    return this.serial(id, async () => {
      const row = this.lookup(id);

      if (!row) return false;

      if (row.status === "deleted") return true;

      this.writeStatus(id, "suspended", true);
      await this.registry(id).destroy();
      this.writeStatus(id, "deleted");

      return true;
    });
  }

  startAudit(
    input: Pick<typeof platformAudit.$inferInsert, "actor" | "tenant" | "operation">,
  ): number {
    return this.db
      .insert(platformAudit)
      .values({ ...input, startedAt: Date.now() })
      .returning({ id: platformAudit.id })
      .get()!.id;
  }

  finishAudit(id: number, outcome: "ok" | "failed"): void {
    this.db
      .update(platformAudit)
      .set({ outcome, finishedAt: Date.now() })
      .where(eq(platformAudit.id, id))
      .run();
  }

  auditLog() {
    return this.db.select().from(platformAudit).orderBy(desc(platformAudit.id)).limit(100).all();
  }

  private operable(row: TenantRow): boolean {
    return !row.deleting && (row.status === "active" || row.status === "suspended");
  }

  private writeStatus(id: string, status: TenantRow["status"], deleting = false) {
    return this.db
      .update(tenants)
      .set({ status, updatedAt: Date.now(), deleting })
      .where(eq(tenants.id, id))
      .returning()
      .get();
  }

  private registry(id: string) {
    return this.env.REGISTRY.getByName(`tenant/${id}`);
  }

  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(id) ?? Promise.resolve()).then(work);

    const done = result.then(
      () => {},
      () => {},
    );

    this.pending.set(id, done);

    try {
      return await result;
    } finally {
      if (this.pending.get(id) === done) this.pending.delete(id);
    }
  }
}
