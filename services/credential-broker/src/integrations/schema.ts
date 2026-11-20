import type { BrokerEndpoint } from "../../../../src/endpoint";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { CredentialReference } from "../credentials/source";
import type { IntegrationKind } from "./types";

export const integrations = sqliteTable("integrations", {
  identity: text().primaryKey(),
  id: text().notNull().unique(),
  kind: text().$type<IntegrationKind>().notNull(),
  endpoint: text({ mode: "json" }).$type<BrokerEndpoint>(),
  enabled: integer({ mode: "boolean" }).notNull(),
  credential: text({ mode: "json" }).$type<CredentialReference>().notNull(),
  credentialVersion: integer("credential_version").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const issuerIntegrations = sqliteTable("issuer_integrations", {
  identity: text()
    .primaryKey()
    .references(() => integrations.identity, { onDelete: "cascade" }),
});
