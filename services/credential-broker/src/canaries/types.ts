import type { EncryptedCredential } from "../credentials/source";
import type { TenantKeyState } from "../grants/registry";
import type { AlertKind } from "./schema";

/** What the broker saw of a request that presented a canary. Values are display strings. */
export interface TripRequest {
  route: string;
  integration: string;
  method: string;
  path: string;
  ip: string;
  country: string;
  asn: string;
  as_org: string;
  colo: string;
  user_agent: string;
}

export interface AlertDelivery {
  identity: string;
  id: string;
  kind: AlertKind;
  config: EncryptedCredential;
  trips: number;
  labels: string[];
}

/** A flat event of display strings, so any webhook receiver can map it without logic. */
export type AlertEvent = Readonly<Record<string, string>>;

export interface Trip {
  event: AlertEvent;
  deliveries: AlertDelivery[];
  keyState: TenantKeyState | null;
}

export interface CanarySummary {
  id: string;
  label: string | null;
  note: string | null;
  integrations: string[];
  createdAt: number;
  trips: number;
  firstTrippedAt: number | null;
  lastTrippedAt: number | null;
}

export interface DestinationSummary {
  id: string;
  kind: AlertKind;
  host: string;
  headerNames: string[];
  createdAt: number;
  lastAlertAt: number | null;
  lastDeliveryAt: number | null;
  lastStatus: number | null;
}

export const maxCanaries = 100;

/** Every destination is sent at once, and a Worker opens at most six connections at a time. */
export const maxDestinations = 5;

export const maxCanaryEvents = 100;

export const alertIntervalMs = 60 * 60_000;
