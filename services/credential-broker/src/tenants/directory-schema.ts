import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["provisioning", "active", "suspended", "deleted"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deleting: integer("deleting", { mode: "boolean" }).notNull().default(false),
});
