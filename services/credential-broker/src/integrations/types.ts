import { z } from "zod";
import type { CredentialReference } from "../credentials/source";

export const integrationKind = z.enum(["github", "anthropic", "openai", "openrouter"]);

export type IntegrationKind = z.infer<typeof integrationKind>;

export interface IntegrationRevision {
  identity: string;
  id: string;
  kind: IntegrationKind;
  credentialVersion: number;
}

export interface StoredIntegration extends IntegrationRevision {
  enabled: boolean;
  credential: CredentialReference;
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationMetadata extends Omit<
  StoredIntegration,
  "identity" | "credential" | "createdAt" | "updatedAt"
> {
  credentialSource: CredentialReference["source"];
  createdAt: string;
  updatedAt: string;
}

export type IntegrationTarget = Pick<StoredIntegration, "id" | "kind">;

export type IntegrationSelector = { type: "github" } | { type: "ai"; id: string };

export const maxIntegrations = 100;
