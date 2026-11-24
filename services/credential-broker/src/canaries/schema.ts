import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { EncryptedCredential } from "../credentials/source";

export const canaries = sqliteTable("canaries", {
  id: text().primaryKey(),
  hash: text().notNull().unique(),
  label: text(),
  note: text(),
  integrations: text({ mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at").notNull(),
  trips: integer().notNull().default(0),
  firstTrippedAt: integer("first_tripped_at"),
  lastTrippedAt: integer("last_tripped_at"),
});

export const canaryEvents = sqliteTable(
  "canary_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    canaryId: text("canary_id")
      .notNull()
      .references(() => canaries.id, { onDelete: "cascade" }),
    event: text({ mode: "json" }).$type<Record<string, string>>().notNull(),
    at: integer().notNull(),
  },
  (table) => [index("canary_events_canary").on(table.canaryId, table.at)],
);

export type AlertKind = "slack" | "webhook";

export const alertDestinations = sqliteTable("alert_destinations", {
  identity: text().primaryKey(),
  id: text().notNull().unique(),
  kind: text().$type<AlertKind>().notNull(),
  config: text({ mode: "json" }).$type<EncryptedCredential>().notNull(),
  host: text().notNull(),
  headerNames: text("header_names", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at").notNull(),
  lastAlertAt: integer("last_alert_at"),
  pendingTrips: integer("pending_trips").notNull().default(0),
  pendingLabels: text("pending_labels", { mode: "json" }).$type<string[]>().notNull().default([]),
  lastDeliveryAt: integer("last_delivery_at"),
  lastStatus: integer("last_status"),
});
