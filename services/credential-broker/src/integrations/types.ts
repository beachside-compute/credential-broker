import type { BrokerEndpoint } from "../../../../src/endpoint";
import { z } from "zod";
import type { CredentialReference } from "../credentials/source";

export const integrationKind = z.enum(["github", "anthropic", "openai", "openrouter", "http"]);

export type IntegrationKind = z.infer<typeof integrationKind>;

export interface IntegrationRevision {
  identity: string;
  id: string;
  kind: IntegrationKind;
  credentialVersion: number;
  endpoint?: BrokerEndpoint | null;
}

export interface StoredIntegration extends IntegrationRevision {
  endpoint: BrokerEndpoint | null;
  enabled: boolean;
  credential: CredentialReference;
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationMetadata extends Omit<
  StoredIntegration,
  "identity" | "credential" | "createdAt" | "updatedAt" | "endpoint"
> {
  endpoint?: BrokerEndpoint;
  credentialSource: CredentialReference["source"];
  createdAt: string;
  updatedAt: string;
}

export type IntegrationTarget = Pick<StoredIntegration, "id" | "kind" | "endpoint">;

export type IntegrationSelector = { type: "github" } | { type: "gateway"; id: string };

export const maxIntegrations = 100;
