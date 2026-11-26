import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { TenantConfig } from "../config";
import type { EncryptedCredential } from "../credentials/source";
import type { TenantRole } from "./identity";

export const tenant = sqliteTable("tenant", {
  id: text("id").primaryKey(),
  config: text("config", { mode: "json" }).$type<TenantConfig>(),
  createdAt: integer("created_at").notNull(),
});

export const roleKeys = sqliteTable("role_keys", {
  role: text("role").$type<TenantRole>().primaryKey(),
  hash: text("hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const dataKeys = sqliteTable("data_keys", {
  version: text("version").primaryKey(),
  wrapped: text("wrapped", { mode: "json" }).$type<EncryptedCredential>().notNull(),
  createdAt: integer("created_at").notNull(),
});
