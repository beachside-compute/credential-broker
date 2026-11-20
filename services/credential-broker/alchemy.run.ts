import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { assertSeparateRoleKeys } from "./src/auth";
import { isBrokerApiKey } from "./src/auth/api-key";
import { parseConfig } from "./src/config";
import { encryptionKeyring } from "./src/credentials/sources/encrypted-store";
import { traceAuthorization, traceEndpoint } from "./src/observability/otlp";
import type { TraceExportBindings } from "./src/observability/otlp";

const compatibilityDate = "2026-11-18";

const config = parseConfig(process.env.BROKER_CONFIG ?? "{}");

const adminKey = alchemy.env("BROKER_ADMIN_KEY");

const issuerKey = process.env.BROKER_ISSUER_KEY;

if (!isBrokerApiKey(adminKey) || (issuerKey !== undefined && !isBrokerApiKey(issuerKey))) {
  throw new Error(
    "Broker role keys must be random 32–256 character base64url values outside the reserved grant-token format",
  );
}

if (!issuerKey && !config.githubActions) {
  throw new Error("Configure a broker issuer key, GitHub Actions OIDC, or both");
}

const encryptionKeys = alchemy.env("BROKER_ENCRYPTION_KEYS");

const activeKeyVersion = alchemy.env("BROKER_ENCRYPTION_KEY_VERSION");

const keyring = encryptionKeyring({
  BROKER_ENCRYPTION_KEYS: encryptionKeys,
  BROKER_ENCRYPTION_KEY_VERSION: activeKeyVersion,
});

assertSeparateRoleKeys(
  { BROKER_ADMIN_KEY: adminKey, BROKER_ISSUER_KEY: issuerKey },
  keyring.keys.values(),
);

const traceUrl = process.env.BROKER_OTLP_TRACES_ENDPOINT;

const tracesEndpoint = traceUrl === undefined ? undefined : traceEndpoint(traceUrl);

const collectorAuthorization = process.env.BROKER_OTLP_AUTHORIZATION;

if (collectorAuthorization !== undefined) traceAuthorization(collectorAuthorization);

const app = await alchemy("beachside-credential-broker", {
  password: alchemy.env("ALCHEMY_PASSWORD"),
  noTrack: true,
});

const registry = DurableObjectNamespace("grant-registry", {
  className: "GrantRegistry",
  sqlite: true,
});

const secretBindings = Object.fromEntries(
  config.workerSecretBindings.map((binding) => [binding, alchemy.secret.env(binding)]),
);

secretBindings.BROKER_ADMIN_KEY = alchemy.secret(adminKey, "BROKER_ADMIN_KEY");

secretBindings.BROKER_ENCRYPTION_KEYS = alchemy.secret(encryptionKeys, "BROKER_ENCRYPTION_KEYS");

if (issuerKey) secretBindings.BROKER_ISSUER_KEY = alchemy.secret(issuerKey, "BROKER_ISSUER_KEY");

if (tracesEndpoint && collectorAuthorization !== undefined) {
  secretBindings.BROKER_OTLP_AUTHORIZATION = alchemy.secret(
    collectorAuthorization,
    "BROKER_OTLP_AUTHORIZATION",
  );
}

const traceVars: Pick<TraceExportBindings, "BROKER_OTLP_TRACES_ENDPOINT"> = {};

if (tracesEndpoint) traceVars.BROKER_OTLP_TRACES_ENDPOINT = tracesEndpoint;

export const worker = await Worker("broker", {
  cwd: import.meta.dir,
  entrypoint: "./src/index.ts",
  bundle: { loader: { ".sql": "text" } },
  compatibilityDate,
  url: true,
  // Native invocation logs and fetch traces can record full URLs supplied by callers.
  observability: {
    enabled: false,
    logs: { enabled: false, invocationLogs: false },
    traces: { enabled: false },
  },
  bindings: {
    ...secretBindings,
    ...traceVars,
    BROKER_CONFIG: JSON.stringify(config),
    BROKER_ENCRYPTION_KEY_VERSION: activeKeyVersion,
    REGISTRY: registry,
  },
});

console.info(worker.url);

await app.finalize();
