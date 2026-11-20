import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const grants = sqliteTable(
  "grants",
  {
    id: text().primaryKey(),
    hash: text().notNull().unique(),
    owner: text().notNull(),
    permissions: text({ mode: "json" }).$type<string[]>().notNull(),
    expiresAt: integer("expires_at").notNull(),
    traceparent: text(),
    rateWindow: integer("rate_window").notNull().default(0),
    rateCount: integer("rate_count").notNull().default(0),
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
  },
  (table) => [index("leases_grant").on(table.grantId)],
);
