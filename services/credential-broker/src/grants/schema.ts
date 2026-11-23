import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const grants = sqliteTable(
  "grants",
  {
    id: text().primaryKey(),
    hash: text().notNull().unique(),
    owner: text().notNull(),
    permissions: text({ mode: "json" }).$type<string[]>().notNull(),
    expiresAt: integer("expires_at").notNull(),
    traceparent: text(),
    createdAt: integer("created_at").notNull().default(0),
    label: text(),
    requests: integer().notNull().default(0),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    index("grants_expiration").on(table.expiresAt),
    index("grants_owner").on(table.owner, table.expiresAt),
  ],
);

export const leases = sqliteTable(
  "leases",
  {
    id: text().primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    identity: text().notNull().default(""),
    expiresAt: integer("expires_at").notNull().default(0),
  },
  (table) => [index("leases_grant").on(table.grantId, table.identity)],
);

export const usage = sqliteTable(
  "grant_usage",
  {
    grantId: text("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    identity: text().notNull(),
    window: integer().notNull(),
    count: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.grantId, table.identity] })],
);
