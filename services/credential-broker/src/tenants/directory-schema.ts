import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["provisioning", "active", "suspended", "deleted"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deleting: integer("deleting", { mode: "boolean" }).notNull().default(false),
});

export const platformAudit = sqliteTable("platform_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenant: text("tenant").notNull(),
  actor: text("actor", {
    enum: ["operator-http", "operator-binding", "control-http", "control-binding"],
  }).notNull(),
  operation: text("operation", {
    enum: [
      "provision",
      "suspend",
      "reactivate",
      "rotate_admin",
      "rotate_issuer",
      "rewrap",
      "erase",
      "rotate_data_key",
    ],
  }).notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  outcome: text("outcome", { enum: ["ok", "failed"] }),
});

export type PlatformActor = typeof platformAudit.$inferSelect.actor;

export type PlatformAction = typeof platformAudit.$inferSelect.operation;
