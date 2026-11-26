# Beachside credential broker

The broker lets a sandbox use GitHub over HTTPS or call HTTPS APIs with expiring grants. Deploy it in your Cloudflare account. A SQLite-backed Durable Object stores the integration catalog, encrypted credentials, issuer permissions, and the grant registry. The Worker authorizes every request and supplies the selected credential to the fixed upstream. A sandbox receives only a grant and instructions for reaching the broker.

## Deploy

For a versioned checkout and upgrade notes, see [Release and deploy the Worker](../../docs/releasing.md#release-and-deploy-the-worker).

Use Bun 1.4.4, Node.js 22 or later, and a Cloudflare account with permission to create a Worker, Worker secrets, and a SQLite Durable Object namespace. Run these commands from the repository root.

```sh
bun install --frozen-lockfile
bun run --cwd services/credential-broker wrangler login
bun run deploy:setup
```

For a remote terminal, use `bun run --cwd services/credential-broker wrangler login --device --browser=false`. Open the printed URL in your browser and enter the displayed code. [Wrangler login options](https://developers.cloudflare.com/workers/wrangler/commands/general/#wrangler-login).

`bun run deploy:setup` is the first deploy. It generates independent admin, issuer and encryption keys in memory, uploads them with the Worker as secrets, and saves only the broker's URL to `.env.deploy` (mode `0600`). It prints the admin and issuer keys once; store them in your password manager and reference them from `.env.deploy` as `BROKER_ADMIN_KEY=op://...` and `BROKER_ISSUER_KEY=op://...` (`bws://`, `pass://` and `env:NAME` work too). The encryption key is never shown, and the Worker holds its only lasting copy. Setup refuses to run when the Worker already has any broker key, so it cannot replace a live broker's keys, and it prints the keys before saving the URL so a local write failure cannot lose them. Outside a terminal, setup requires `--print-keys` (`bun run deploy:setup --print-keys`), because the keys would otherwise land in a log unnoticed. If the deploy fails, setup discards the keys; when a retry reports that the new Worker already has keys, delete that Worker with `bun run --cwd services/credential-broker wrangler delete` and run setup again. For unattended deployment, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` alongside your broker settings. [Wrangler permissions and API token authentication](https://developers.cloudflare.com/workers/authorization/).

`bun run deploy` updates the Worker's code and its non-key settings (`BROKER_CONFIG`, OTLP tracing and `CREDENTIAL_…` bindings). It never uploads the admin, issuer or encryption keys, even when they are set, and refuses to deploy a Worker that setup has not created. Run `bun run deploy --dry-run` to check the Worker bundle offline.

### Use a custom hostname

If you deploy from your own fork, edit [`wrangler.jsonc`](./wrangler.jsonc) there and commit it. Merging upstream then brings in new Durable Object migrations, and a conflict tells you when an upstream change touches the same settings.

Without a fork, put deployment-specific Wrangler settings in `services/credential-broker/wrangler.local.jsonc`, starting from [`wrangler.local.jsonc.example`](./wrangler.local.jsonc.example). Git ignores that file, and `bun run deploy` merges its top-level keys over the tracked [`wrangler.jsonc`](./wrangler.jsonc), so upstream changes such as Durable Object migrations still reach you. It cannot set `main`, `durable_objects` or `migrations`. For a custom hostname, add a `routes` entry in a Cloudflare zone on the account you deploy to. A `CLOUDFLARE_API_TOKEN` needs Zone > Workers Routes > Write on that zone. `--dry-run` does not show routes, so check the new hostname after deploying with `bun run broker status --url https://broker.example.com`. Set `workers_dev` to `false` to disable the default `workers.dev` hostname, but only once every sandbox and workflow uses the new URL. [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

```jsonc
{
  "routes": [{ "pattern": "broker.example.com", "custom_domain": true }],
  "workers_dev": false,
}
```

### Configure deployment bindings

`.env.deploy` holds settings, not keys. See the [deployment template](../../.env.deploy.example). You can also supply the settings through exported environment variables. The file takes precedence for values it sets. `bun run broker` sends a key referenced from the file only to the file's `BEACHSIDE_BROKER_URL` or an explicit `--url`, never to a URL that only the environment sets. `CREDENTIAL_…` bindings and `BROKER_OTLP_AUTHORIZATION` accept the same references as the role keys; deploys resolve them before uploading. An `.env.deploy` from an older setup that holds keys as values keeps working once it has the broker's URL (add `BEACHSIDE_BROKER_URL=https://…` or run `bun run deploy`, which saves it; `deploy:setup` is only for a new broker), but `bun run broker` and `bun run deploy` warn until you move the admin and issuer keys into your password manager and delete `BROKER_ENCRYPTION_KEYS` from the file. A deploy also replaces a saved `BEACHSIDE_BROKER_URL` that differs from the origin Wrangler printed, because `bun run broker` sends the file's keys to that URL. The runtime `.dev.vars` file is for local development.

| Variable                                                      | Value                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BROKER_ADMIN_KEY`                                            | Management bearer key, set by setup. In `.env.deploy`, a reference for `bun run broker`.                          |
| `BROKER_ISSUER_KEY`                                           | Static grant-issuance bearer key, set by setup. In `.env.deploy`, a reference for `bun run broker`.               |
| `BEACHSIDE_BROKER_URL`                                        | The broker's origin, saved by setup, for `bun run broker`.                                                        |
| `BROKER_CONFIG`                                               | Optional JSON for GitHub Actions trust policies and declared Worker secret bindings. Defaults to an empty object. |
| `CREDENTIAL_…`                                                | Upstream keys for optional Worker-secret integrations named in `BROKER_CONFIG.workerSecretBindings`.              |
| `BROKER_OTLP_TRACES_ENDPOINT` and `BROKER_OTLP_AUTHORIZATION` | Optional trace endpoint and collector authorization.                                                              |
| `BROKER_EMAIL_FROM`                                           | Optional sender for `email` canary alerts. Deploys add the `send_email` binding only when it is set.              |
| `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`            | Optional provisioning credentials and account selection for Wrangler automation.                                  |

The deployment command passes only Worker bindings to Wrangler in a private temporary secrets file and removes it after the command completes; on the first deploy that file briefly holds the generated keys. Wrangler runs without the broker settings or `BEACHSIDE_BROKER_*` keys from your environment. It uploads `BROKER_CONFIG` as a Worker secret binding. A Worker's very first deploy can upload and then fail with Cloudflare error 10007 while the Workers API catches up; the command deploys once more when that happens.

Wrangler preserves previously deployed secrets omitted from a later upload, which is how the keys outlive every update. To remove an optional binding such as the static issuer key or OTLP authorization, remove it from your deployment settings and explicitly delete it from the same Worker. For example, configure GitHub Actions OIDC before removing the static issuer key. [Wrangler secret removal](https://developers.cloudflare.com/workers/configuration/secrets/#delete-secrets-from-your-project).

```sh
bun run --cwd services/credential-broker wrangler secret delete BROKER_ISSUER_KEY
```

Use the HTTPS origin Wrangler prints in the client. The Durable Object applies pending migrations on startup. After schema changes, run `bun run --cwd services/credential-broker db:generate --name your_change` and commit its SQL, journal, snapshot, and bundled migration index. A new deployment begins with an empty integration catalog and issuer allowlist.

### Deploy directly with Wrangler

Use `bun run deploy:wrangler` to manage Wrangler arguments and Worker secrets yourself. The [Wrangler configuration](./wrangler.jsonc) creates the `beachside-credential-broker` Worker and its SQLite-backed grant registry. Without bindings, the Worker uses encryption key version `v1` and an empty `BROKER_CONFIG`. Supply custom runtime settings as secret bindings. Preview URLs are off, so only the deployed version is reachable. Use the same deployment path when updating the Worker and registry.

Put the Worker secret values in a protected JSON file outside the repository. For static issuance, furnish these fields. The keyring is a JSON-encoded string.

```json
{
  "BROKER_ADMIN_KEY": "GENERATED_ADMIN_KEY",
  "BROKER_ISSUER_KEY": "GENERATED_ISSUER_KEY",
  "BROKER_ENCRYPTION_KEYS": "{\"v1\":\"GENERATED_ENCRYPTION_KEY\"}"
}
```

```sh
bun run deploy:wrangler --secrets-file /secure/path/broker-secrets.json
```

Native Workers logs and traces are disabled as they can capture full request URLs. [Wrangler secret uploads](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code).

### Run Wrangler locally

Copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars` in this directory. Generate a separate local-only value for each role key and for the `v1` encryption key. Run this command once for each value.

```sh
node -p 'require("node:crypto").randomBytes(32).toString("base64url")'
```

Fill in the three values, then start the Worker from the repository root.

```sh
bun run dev
```

Wrangler runs the Worker and SQLite Durable Object locally. The client and CLI accept plain HTTP for `localhost`, `127.0.0.1` and `[::1]`, so point them at the local URL with your fixture keys.

```sh
BEACHSIDE_BROKER_URL=http://localhost:8787 \
BEACHSIDE_BROKER_ADMIN_KEY="$(sed -n 's/^BROKER_ADMIN_KEY=//p' services/credential-broker/.dev.vars)" \
  bun run broker status
```

Keys referenced from `.env.deploy` take precedence, so run this from a checkout without one, or use the installed `beachside-broker` command, which reads only the environment.

## Hosted tenants

A deployment with no `BROKER_TENANT_DOMAIN` serves just the built-in broker over HTTP. Its hostname, `grant-registry` object, role keys, and configuration stay in place. Apply the bundled Worker upgrade before enabling tenant access.

Set a hostname suffix under a Cloudflare zone you control. Use a proxied wildcard DNS record, a TLS certificate for that wildcard, and a Workers Route. Continue to serve your existing broker hostname. For example, add this to `wrangler.local.jsonc` and keep every other broker hostname in `BROKER_HOST_ALIASES`, including your `workers.dev` hostname if enabled. The broker blocks hosted-tenant HTTP integrations and alert destinations from targeting these names or any tenant subdomain. Keep the list current when adding an alias. [Cloudflare Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)

```jsonc
{
  "routes": [
    { "pattern": "broker.example.com", "custom_domain": true },
    { "pattern": "*.broker.example.com/*", "zone_name": "example.com" },
  ],
  "workers_dev": false,
  "vars": {
    "BROKER_TENANT_DOMAIN": "broker.example.com",
    "BROKER_HOST_ALIASES": "another-broker.example.com",
  },
}
```

The hosted control plane uses private Service Bindings to the same broker Worker. Bind the SaaS app to the `PlatformControl` entrypoint for `provision`, `list`, and `inspect`. Bind a separate trusted operator Worker to `PlatformOperator` for `setStatus`, `rotateRoleKey`, `rewrap`, `erase`, and `auditLog`. A platform binding grants the calling Worker all operations exported by that entrypoint. The operator audit log records tenant ID, operation, channel, timestamps, and outcome. The authenticated operator application can keep a separate audit trail for its individual human callers.

```jsonc
{
  "services": [
    {
      "binding": "BROKER_CONTROL",
      "service": "beachside-credential-broker",
      "entrypoint": "PlatformControl",
    },
  ],
}
```

### Optional platform HTTP API

Private RPC works independently of the HTTP switch. Leave `BROKER_PLATFORM_HTTP_ENABLED` unset for RPC-only operation. To enable the API, set it to the string `"true"` in Wrangler vars. On an existing Worker, `bun run deploy:setup --platform-key-only` creates any missing HTTP keys over Wrangler's standard input and prints each once. The routine `BROKER_PLATFORM_KEY` authorizes provisioning, listing, and inspection. `BROKER_PLATFORM_OPERATOR_KEY` authorizes status changes, role-key rotation, rewrap, and deletion. Plain `bun run deploy` omits both secrets.

The API returns new role keys once and exposes tenant status and counts. It keeps stored upstream credentials and tenant data keys private.

| Platform route                                    | Behaviour                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/platform/tenants`                       | Creates a tenant with a caller-chosen lowercase alphanumeric ID of 8–32 characters. Returns `id`, `adminKey` and `issuerKey`. Retry a tenant in `provisioning`. Active, suspended, and deleted IDs are reserved. |
| `GET /v1/platform/tenants`                        | Lists tenant IDs, statuses, and timestamps. Pass `limit` and then `after` with the returned `next` cursor.                                                                                                       |
| `GET /v1/platform/tenants/:id`                    | Reads the lifecycle state and counts when the registry is available.                                                                                                                                             |
| `PATCH /v1/platform/tenants/:id`                  | Sets `status` to `active` or `suspended`. Allow up to 30 seconds for cached lookups to expire.                                                                                                                   |
| `POST /v1/platform/tenants/:id/keys/:role/rotate` | Replaces an `admin` or `issuer` key. Returns the replacement once and invalidates the old key.                                                                                                                   |
| `POST /v1/platform/tenants/:id/rewrap`            | Re-encrypts the tenant's data key under the active root key.                                                                                                                                                     |
| `DELETE /v1/platform/tenants/:id`                 | Suspends access, erases tenant data, and keeps a tombstone for the ID. Safe to retry.                                                                                                                            |

Use `https://<id>.broker.example.com` as the tenant's broker URL in the client, Git remotes, and gateways. Tenant role keys work only on that hostname. Sandbox grants keep the existing `bsg_<64 hex>` format. Hosted canaries trip on their own hostname on proxy, management, and enabled platform HTTP routes. Tenant admins use `PUT /v1/admin/config` or the admin client's `setConfig` to replace the stored `githubActions` policy and per-grant `limits`. GitHub Actions tokens must have the exact audience `beachside-broker:<id>` and go to the matching tenant hostname. Hosted tenants can use encrypted-store integrations and Slack or webhook alert destinations.

For root key rotation, keep the old root in `BROKER_ENCRYPTION_KEYS` while you add the replacement and set `BROKER_ENCRYPTION_KEY_VERSION` to make it active. Call `rewrap` for each active or suspended tenant and verify success before retiring the old root. Rewrap preserves the tenant data key, so existing tenant integration ciphertext and grants remain usable. The built-in broker's ciphertext is encrypted directly with the root keyring. Keep old root versions until those integrations and alert destinations have also been rotated or recreated.

## Trusted token issuers

An operator can configure up to four issuers in deployment `BROKER_CONFIG.trustedIssuers`. Each entry sets the exact issuer, HTTPS JWKS URI and audience, and the roles it may sign. Set the audience to the broker origin for a pinned issuer or to `https://<BROKER_TENANT_DOMAIN>` for hosted issuers. Roles default to `["issuer"]`.

```json
{
  "trustedIssuers": [
    {
      "issuer": "https://api.example.com",
      "jwksUri": "https://api.example.com/.well-known/jwks.json",
      "audience": "https://gateway.example.com",
      "roles": ["issuer"],
      "tenant": "k3j9x2m4p7q1"
    }
  ]
}
```

A pinned entry accepts only its configured org's `tenant` claim on the built-in broker. This works with the default hostname and without a platform key. An unpinned entry requires `BROKER_TENANT_DOMAIN`. Granting it `admin` lets that issuer administer every hosted tenant. Send the bearer token to the tenant subdomain named in its signed `tenant` claim.

Sign tokens with ES256 and include `iss`, `aud` as a string, `sub`, `iat`, `exp`, `tenant`, and `role`. The broker rejects expired tokens and tokens issued more than 600 seconds ago. Subjects must be 1–128 printable ASCII characters. Use a stable, distinct subject per agent so it can list, renew, and revoke its own grants. Each issuer has its own subject namespace. The optional integration scope also applies to listing, renewal, and revocation. An issuer token may include an `integrations` array to narrow its permissions further. Present the JWT as an `Authorization: Bearer` credential to the matching admin or issuance API. The admin config endpoint reports applicable issuers and roles.

## Manage integrations

From the deployment checkout, open the integration setup wizard. Choose OpenRouter, keep the ID `openrouter`, and enter its upstream API key when prompted. The command runs the management CLI with the URL and the admin key referenced from `.env.deploy`, and lets the issuer mint grants for the new integration unless you pass `--no-allow-issue`.

```sh
bun run broker status
bun run broker integration setup
```

The integration ID is the name a sandbox uses to request access. Enter a unique ID for a second key of the same provider. Add `--json` to write the integration metadata to stdout. You can also pass `--url` for one command, or set `BEACHSIDE_BROKER_URL` and `BEACHSIDE_BROKER_ADMIN_KEY` in the environment. With no key configured, the command asks for it at the terminal and keeps it for that run only; without a terminal it stops with an error. The separately installed `beachside-broker` CLI and `beachside broker` in the Beachside CLI run the same commands.

The issuance allowlist decides which integrations the issuer can mint grants for. `integration create --allow-issue` and the setup wizard add the new integration. Change it one ID at a time, or replace the whole list.

```sh
bun run broker issuer show
bun run broker issuer allow openrouter
bun run broker issuer deny openrouter
bun run broker issuer set openrouter github-work
```

`integration list` shows each integration's state, whether it is allowed to issue, its upstream and credential version. `config show` prints the GitHub Actions trust policy and the request limits from `BROKER_CONFIG`.

### Issue and manage grants

```sh
bun run broker grant issue openrouter --ttl 12h --label "sandbox web"
bun run broker grant list
bun run broker grant renew GRANT_ID --ttl 7d
bun run broker grant revoke GRANT_ID
```

Use the base URL for each integration as the client's API base and the token as its API key. The broker reports each integration's kind, so the URL already maps to the upstream base for built-in and configurable integrations. Grants default to 15 minutes. `--ttl` takes seconds or a number with `s`, `m`, `h` or `d`, up to `7d`. `--token` prints only the token and `--json` the full record. Keep the output private.

`grant list` shows the issuer's active grants with their integrations, label, expiry, request count and last use. `grant list --all` uses the admin key to show every grant and its issuing authority. Grant commands use the `BROKER_ISSUER_KEY` reference in `.env.deploy`. For the installed CLI, set `BEACHSIDE_BROKER_URL` and `BEACHSIDE_BROKER_ISSUER_KEY`, as the key or a reference.

Create integrations with kind `github`, `anthropic`, `openai`, `openrouter`, or `http`. Kind and upstream destination are fixed for an integration's lifetime. The broker supports up to 100 names per deployment and multiple GitHub integrations. One grant can use at most one GitHub integration. A GitHub grant delegates the upstream token's Git and GraphQL access. Use upstream tokens with the repository scope and operations the sandbox needs.

Encrypted-store credentials are encrypted before the Worker sends their envelopes to SQLite. AES-256-GCM uses a fresh nonce for every write and authenticates the integration identity, credential version, and encryption key version. Use `integration rotate <id> --secret-stdin` with a replacement credential. Subsequent requests using an existing grant see the replacement. Requests that already passed authorization may finish with the prior credential.

For a declared Worker secret, use `integration create <id> --provider <kind> --worker-secret CREDENTIAL_NAME`. The registry stores its reference. After you update the Worker secret on the deployment, subsequent requests resolve the new value.

`integration disable <id>` and `integration delete <id>` revoke every grant that includes the integration. Re-enabling can admit fresh grants. Deleting and recreating a name creates a new identity and requires setting issuer permissions again. The admin API returns integration metadata, including the source kind and credential version. There is no API to retrieve plaintext or ciphertext.

| Admin request                               | Input and result                                                                                | Operation errors                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/integrations`                | Returns `{ "integrations": [...] }` containing integration metadata.                            |                                                                                                                                   |
| `POST /v1/admin/integrations`               | Body `{ "id": "...", "kind": "...", "credential": {...} }` returns metadata with `201`.         | `400` invalid input, `409 integration_exists`, `429 integration_limit`, `503 credential_unavailable`                              |
| `GET /v1/admin/integrations/:id`            | Returns integration metadata.                                                                   | `400` invalid ID, `404 integration_not_found`                                                                                     |
| `PATCH /v1/admin/integrations/:id`          | Body `{ "enabled": true }` or `{ "enabled": false }` returns updated metadata.                  | `400` invalid input, `404 integration_not_found`                                                                                  |
| `PUT /v1/admin/integrations/:id/credential` | Body is a credential object. Returns updated metadata.                                          | `400` invalid input, `404 integration_not_found`, `409 integration_changed` for a concurrent change, `503 credential_unavailable` |
| `DELETE /v1/admin/integrations/:id`         | Returns `204`, including if the name is absent.                                                 | `400` invalid ID                                                                                                                  |
| `GET /v1/admin/issuer-permissions`          | Returns `{ "integrations": ["..."] }`.                                                          |                                                                                                                                   |
| `PUT /v1/admin/issuer-permissions`          | Replaces the allowlist with `{ "integrations": ["..."] }`. An empty list disables new issuance. | `400` invalid input, `404 integration_not_found` for an unknown ID                                                                |
| `PUT /v1/admin/issuer-permissions/:id`      | Adds one integration to the allowlist. Returns the list.                                        | `400` invalid ID, `404 integration_not_found`                                                                                     |
| `DELETE /v1/admin/issuer-permissions/:id`   | Removes one integration from the allowlist. Returns the list.                                   | `400` invalid ID, `404 integration_not_found`                                                                                     |
| `GET /v1/admin/grants`                      | Returns `{ "grants": [...] }` with every active grant and its `owner`.                          |                                                                                                                                   |
| `GET /v1/admin/config`                      | Returns the GitHub Actions policy, the number of Worker secret bindings, and `issuerKey`.       |                                                                                                                                   |

All admin routes can return `401 administrator_authentication_required` or `503 broker_unavailable`. For a Worker-secret reference, an undeclared binding and a declared binding with an absent or invalid secret both return `503 credential_unavailable`. Check the declared binding names and the provisioned Worker secrets on the operator host. API responses omit secret values and Worker binding names. HTTP integration metadata includes the configured URL, header names, literal values, and secret prefixes.

A credential object is `{ "source": "encrypted-store", "value": "..." }` or `{ "source": "worker-secret", "binding": "CREDENTIAL_NAME" }`. The `http` kind uses the endpoint and credential objects below. Supply the admin key as a bearer token. The admin key cannot issue grants or access gateways.

### Configurable HTTPS endpoints

Use `node dist/cli.js integration setup` from an interactive terminal or supply JSON on stdin. The Anthropic preset configures `anthropic-version: 2023-06-01` for messages clients. The create command reads the `endpoint` and `credential` fields from a protected file or secret-manager output.

```sh
node dist/cli.js integration create gateway-work --provider http --config-stdin < /secure/path/gateway-integration.json
```

For example, a Cloudflare AI Gateway configured with OpenAI as the upstream takes two independent credentials. Use the [Cloudflare provider-native base URL](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/).

```json
{
  "endpoint": {
    "baseURL": "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/openai",
    "headers": [
      { "name": "authorization", "secret": true, "prefix": "Bearer " },
      { "name": "cf-aig-authorization", "secret": true, "prefix": "Bearer " }
    ]
  },
  "credential": {
    "source": "encrypted-store",
    "values": {
      "authorization": "OPENAI_KEY_FROM_SECRET_MANAGER",
      "cf-aig-authorization": "CLOUDFLARE_TOKEN_FROM_SECRET_MANAGER"
    }
  }
}
```

A configured header is either `{ "name": "authorization", "secret": true, "prefix": "Bearer " }` or `{ "name": "x-tenant", "value": "team-a" }`. Omit the prefix to send the secret verbatim. Header names are case-insensitive and unique. Keep secrets out of the base URL, literal values, and prefixes, which appear in admin metadata. Use up to eight headers with names of up to 64 characters. Use up to 128 printable ASCII characters for each prefix and up to 1,024 for each literal value. Secret values are 1–4,096 printable ASCII bytes with no leading or trailing space. HTTP integrations currently use encrypted-store credentials. Use `{ "source": "encrypted-store", "values": {} }` when the endpoint has no secret headers. The broker binds the encrypted values to the endpoint configuration, integration identity, and credential version.

The admin create API takes the same JSON plus `"id": "gateway-work"` and `"kind": "http"`. The base URL requires a multi-label HTTPS DNS hostname, with no URL credentials, query, or fragment. The submitted and normalized URLs each have a 2,048-character limit. IP literals and hostnames ending in `.local`, `.localhost`, `.internal`, `.test`, `.invalid`, or `.example` are rejected. Administrators must trust the destination and its DNS. The broker validates URL syntax without resolving addresses or enforcing public DNS answers. The URL and header definitions are immutable. Review the integration and add it to the issuer allowlist when ready. To change the destination or header definitions, create a replacement integration and retire the old one.

Update the admin client and CLI before creating HTTP integrations. An older admin client rejects metadata for this new kind.

To rotate one or more headers, pipe in a JSON map that contains only the replacement values. The admin rotate API receives `{ "source": "encrypted-store", "values": {...} }`. Use `--secret-stdin` or `--worker-secret` for the built-in kinds. Omitted HTTP secret headers keep their current values and existing grants remain valid. After an encryption key rotation, provide every secret value from its original source or rotate it to a fresh upstream value. An endpoint with no secret headers can be re-encrypted with an empty map.

```sh
node dist/cli.js integration rotate gateway-work --credentials-stdin < /secure/path/replacement-headers.json
```

A grant can call HTTP paths beneath the configured base. For example, a request to `/gateway/gateway-work/chat/completions` reaches `/v1/ACCOUNT_ID/GATEWAY_ID/openai/chat/completions` on the Cloudflare gateway. Use a bearer grant or `x-api-key`, with one authentication header per request. The broker consumes the grant header and strips hop-by-hop, forwarding, client identity, cookie, and known tracing headers, including `traceparent`, `baggage`, `sentry-trace`, `grpc-trace-bin`, and the `x-b3-*` and `x-datadog-*` families. It also strips guest `cf-*` headers. Administrators can configure `cf-aig-*` headers. Configured headers replace guest values. Ordinary application headers such as `x-request-id` and `x-correlation-id` pass through as application data. Configure provider-side scopes and limits for all methods and paths the upstream exposes. Trust the endpoint to keep injected values out of its response bodies, where the broker streams the upstream bytes directly.

The broker blocks redirects, WebSocket upgrades, and CONNECT, TRACE, and TRACK. Paths reject encoded separators, double slashes, matrix parameters, and segments ending in a dot or whitespace. The HTTP gateway supports server-sent events and streaming bodies. Response filtering removes cookies, redirect targets, and configured secret header names. It also removes headers that match a raw secret, contain a prefixed secret, or contain a raw secret of at least eight characters. This filtering is best effort. Use trusted upstreams that keep credentials out of responses.

### Rotate keys

Deploys never change the broker's keys. To replace the admin or issuer key, generate a new value with `node -p 'require("node:crypto").randomBytes(32).toString("base64url")'`, paste it into Wrangler's prompt, then update it in your password manager and on every machine that uses it.

```sh
bun run --cwd services/credential-broker wrangler secret put BROKER_ISSUER_KEY
```

The admin, issuer and encryption keys must be distinct, 32–256 base64url characters each.

The Worker holds the only lasting copy of the encryption key, and Worker secrets cannot be read back, so there is no recovery path: if the secret is lost or replaced, integrations encrypted with it must be re-entered. To replace it, upload a keyring with only a new key under a new version label, then rotate every encrypted integration with its upstream credential. Integrations fail until they are rotated, because the old key is gone. Every successful rotation writes with the active version and a fresh nonce.

```sh
printf '{"BROKER_ENCRYPTION_KEYS":"{\\"v2\\":\\"%s\\"}","BROKER_ENCRYPTION_KEY_VERSION":"v2"}' \
  "$(node -p 'require("node:crypto").randomBytes(32).toString("base64url")')" |
  bun run --cwd services/credential-broker wrangler secret bulk
bun run broker integration rotate openrouter --credentials-stdin < /secure/path/replacement-headers.json
```

## Authenticate grant issuance

A static issuer passes `BROKER_ISSUER_KEY` as a bearer token. It can issue grants only for the administrator's allowlist and revoke grants issued under the static issuer role. The allowlist begins empty. Changing it gates new issuance. Existing grants remain authorized until expiry, explicit revocation, integration disable, or integration deletion.

GitHub Actions jobs must match both the administrator's current allowlist and an exact integration ID listed in the job's deployment policy. For example:

```json
{
  "githubActions": {
    "audience": "https://broker.example.com/github-actions",
    "workflows": [
      {
        "repositoryId": "123456789",
        "repositoryOwnerId": "23456789",
        "repository": "example-org/review-service",
        "ref": "refs/heads/main",
        "workflowRef": "example-org/review-service/.github/workflows/review.yml@refs/heads/main",
        "event": "pull_request_target",
        "integrations": ["github-work"]
      }
    ]
  }
}
```

Give the trusted orchestration job `id-token: write` and request a token for the configured audience. Pick an audience unique to the deployment. The [credential client](../../README.md) can request the token from the runner. The broker verifies GitHub's signature, issuer, exact audience, expiry, token age, repository and owner IDs, repository name, workflow path and ref, and event. A matching workflow can list, renew and revoke the grants issued within its own workflow run. A later run, even of the same workflow, cannot renew them, so use a static issuer key for a grant that must outlive the run, such as an always-on sandbox.

Supported events are `push`, `schedule`, `workflow_dispatch`, `workflow_run`, and `pull_request_target`. For a reusable workflow, configure the called workflow's exact `jobWorkflowRef`. For a direct job, omit it. The broker accepts an absent `job_workflow_ref` or one that matches `workflowRef`. Trust refs controlled by your operators. For `pull_request_target` and `workflow_run`, keep PR-controlled code, actions, scripts, and artifacts out of the orchestration job. Run untrusted work inside the sandbox after issuing its limited grant.

## Grant API

| Request                     | Result                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/grants`           | Create a grant with body `{ "integrations": ["github-work"], "ttlSeconds": 900, "label": "sandbox web" }` (`label` is optional). The response is `201` and has `id`, `token`, `expiresAt` (ISO 8601), `integrations`, and `kinds` (each integration's kind). A refused integration returns `403` with `reason` (`not_found`, `disabled`, `not_allowlisted` or `not_in_policy`) and the `integrations` it names. |
| `DELETE /v1/grants/:id`     | Revoke under the issuing workflow run or static issuer key. Repeated requests return `204`.                                                                                                                                                                                                                                                                                                                     |
| `POST /v1/grants/:id/renew` | Body `{ "ttlSeconds": 604800 }`. Moves an active grant's expiry. Returns the grant summary, or `404 grant_not_found` for an expired, revoked or foreign grant.                                                                                                                                                                                                                                                  |
| `GET /v1/grants`            | Returns `{ "grants": [...] }`: the caller's active grants with `id`, `integrations`, `label`, `createdAt`, `expiresAt`, `requests` and `lastUsedAt`. Tokens are never listed.                                                                                                                                                                                                                                   |
| `GET /v1/status`            | With the admin, issuer or a workflow token. Returns `apiVersion`, `role`, `limits.maxGrantTtlSeconds`, and for the admin key integration and grant counts.                                                                                                                                                                                                                                                      |

Grants last between 1 second and 7 days (604,800 seconds). An issuer can renew its own active grant to a new lifetime of up to 7 days from the renewal, keeping its token and scope. There is no overall cap: each renewal can add up to another 7 days, so a grant renewed weekly lives until it is revoked. The 7-day limit bounds how long a forgotten grant stays live, not a grant's total lifetime. A grant can use its selected integrations immediately and cannot manage grants. The operation is authorized again for every gateway request. Revocation and expiry reject new requests. Requests that have already passed authorization, including active model streams and writes, may finish. A lost response to grant creation may leave a record until its expiry, and the broker cannot recover the raw grant token.

By default the registry admits up to 1,000 active grants and up to 100 per issuing authority (one static issuer role or one workflow run). Request limits apply to each grant and integration separately, counting streams. A GitHub integration allows 800 requests per UTC minute and 32 concurrent requests, since one clone or fetch makes many requests at once. The `anthropic`, `openai` and `openrouter` model gateways allow 600 per minute and 32 concurrent. Administrator-configured `http` endpoints allow 300 per minute and 8 concurrent. A concurrency slot frees when its response finishes. A running request renews its slot every 5 minutes, so a slot whose release is lost frees within 15 minutes. A request over a bound receives HTTP `429 grant_request_limit`. Set provider-side token scopes, spend limits, and quotas to constrain delegated use.

Override the limits for up to 100 integration IDs in `BROKER_CONFIG`, up to 100,000 per minute and 1,000 concurrent each. Omitted fields keep their defaults. `config show` lists each integration's effective limits and warns about IDs that match no integration:

```json
{
  "limits": {
    "github-work": { "requestsPerMinute": 2000, "concurrentRequests": 64 },
    "openrouter": { "requestsPerMinute": 300 }
  }
}
```

## Use the gateways

Use the [credential client](../../README.md) for Beachside-managed environment variables and revocation. It gives each opted-in sandbox a distinct grant. The client also works outside Beachside, where its caller owns revocation.

- **Git HTTPS** uses the broker remote `https://<broker-host>/<owner>/<repo>.git` and the grant password with username `x-access-token`. The client configures Git to rewrite `https://github.com/` remotes in the sandbox's command environment. Clone, fetch and push are supported over smart HTTP. Use the `.git` suffix for the GitHub owner `gateway` to disambiguate its repository from a configurable HTTP route. SSH, Git LFS, and submodules on unrelated hosts use their own access paths.
- **GitHub CLI** uses `GH_HOST=<broker-host>` and `GH_ENTERPRISE_TOKEN=<grant>`. Give commands an explicit `--repo <broker-host>/<owner>/<repo>` if local remotes might resolve to another host. The broker maps GHES-style REST and GraphQL URLs to GitHub.com using the grant's single GitHub integration. Repo view, issue list/create, and PR list/create/comment have CLI fixtures. Canonical links returned by GitHub still point to GitHub.com. Browser views, auth login, workflows, releases, downloads, and endpoints outside the REST allowlist may require direct access. REST branch and commit reads accept single-component refs. Use GraphQL for refs containing slashes, such as `feature/login`. GraphQL forwards the queries and mutations allowed by the GitHub token.
- **Anthropic** uses `ANTHROPIC_BASE_URL=https://<broker-host>/gateway/<integration>` and `ANTHROPIC_API_KEY=<grant>`. The gateway supports messages, token counts, and model metadata.
- **OpenAI** and **OpenRouter** use `OPENAI_BASE_URL` or `OPENROUTER_BASE_URL` ending in `/gateway/<integration>/v1`. Supply the grant in the respective `*_API_KEY`. The gateway forwards model metadata, chat completions, responses creation, and embeddings where the upstream provider supports them. Files, key management, account endpoints, realtime WebSockets, and retrieval of stored responses are outside this gateway.

The built-in integrations use a fixed upstream per kind. It filters request and response headers, forwards permitted requests with the upstream credential, and streams bodies and server-sent events. Built-in gateways can rewrite supported same-upstream read redirects back through the broker. The GitHub gateway also rewrites supported REST pagination links. Other redirects are rejected. The broker sends each write once. A transport error may still leave an upstream write applied.

### OpenCode

In OpenCode v2, point a selected API-key provider's `settings.baseURL` and `settings.apiKey` at the environment provided by the credential client. Use the provider's HTTP transport. For example, put this in the sandbox's OpenCode configuration when using the OpenAI integration.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "openai": {
      "settings": {
        "baseURL": "{env:OPENAI_BASE_URL}",
        "apiKey": "{env:OPENAI_API_KEY}",
        "transport": "http"
      }
    }
  }
}
```

Use the corresponding environment variables for Anthropic or OpenRouter. In OpenCode v1, provider settings live under `provider.<id>.options`. These recipes use API keys and HTTP model endpoints. [OpenCode provider configuration](https://opencode.ai/docs/providers/)

## Canary tokens

A canary is a decoy grant the administrator issues to detect a leak. Plant one where only an intruder would find it: a decoy `.env`, a CI secret on an unused workflow, a sandbox image. Nothing legitimate ever uses it. It only detects use against this broker. A provider key used directly at its provider never reaches it.

- **Looks like a grant.** It has the same `bsg_` token, the same issue response, and `canary issue --env` prints the variables a sandbox grant would get. Only the admin key can issue, list or see canaries. The issuer key and workflow tokens never see them, and they count toward no grant limits. A canary never expires; it stays live until revoked.
- **Refused like an unknown grant.** A gateway, git or GitHub API request with a canary gets the same `401 grant_invalid` as an expired grant. The token is never proxied, and no credential is resolved.
- **Also trips on management use.** Presenting a canary token as the admin or issuer key, or renewing or revoking a canary's ID with an issuer key, records a trip too. The responses stay unchanged.
- **Recorded.** Each canary keeps its trip count and its last 100 uses. A use records the route, method and path (never the query string), IP address, country, ASN, network name, Cloudflare colo and user agent.

```sh
bun run broker alert add slack ops-chat --to-stdin < /secure/path/slack-webhook-url
bun run broker alert add webhook pager --to-stdin --header "Authorization=op://Ops/incident-io/canary-source" < /secure/path/alert-url
bun run broker alert add email inbox --to oncall@example.com
bun run broker alert test pager
bun run broker canary issue openrouter github --label "decoy .env on build-box" --env > decoy.env
bun run broker canary list
bun run broker canary show <canary-id>
bun run broker canary revoke <canary-id>
```

Every destination receives every canary's alerts, and a broker holds up to 5, because alerts go to all of them at once and a Worker opens at most six connections at a time. There are three kinds of destination:

- **`slack`** takes a Slack incoming webhook URL on `hooks.slack.com` and posts a readable message.
- **`webhook`** takes any HTTPS URL and up to 10 custom headers, with at most 16 KB of URL and headers combined. It posts one flat JSON object of strings, signed per [Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<HMAC-SHA256>`. The signing secret is printed once, when you add the destination.
- **`email`** takes one address and sends a plain-text email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/). It needs a sending domain on Cloudflare DNS and Workers Paid; see [Email alerts](#email-alerts).

The URL, header values and signing secret are sealed with the broker's encryption key. Listings show only the host and header names, or an email destination's address. Rotating the encryption key means re-adding destinations.

```json
{
  "type": "canary.triggered",
  "event_id": "evt_…",
  "dedup_key": "beachside-canary-<canary-id>",
  "status": "firing",
  "severity": "critical",
  "title": "Canary \"decoy .env on build-box\" used from 203.0.113.7 (DigitalOcean, NL) via gateway",
  "broker_host": "broker.example.com",
  "canary_id": "…",
  "canary_label": "decoy .env on build-box",
  "canary_note": "",
  "occurred_at": "2026-11-23T22:40:00.000Z",
  "trips_total": "3",
  "trips_since_last_alert": "2",
  "canaries_tripped": "decoy .env on build-box",
  "request_route": "gateway",
  "request_integration": "openrouter",
  "request_method": "POST",
  "request_path": "/gateway/openrouter/v1/chat/completions",
  "request_ip": "203.0.113.7",
  "request_country": "NL",
  "request_asn": "14061",
  "request_as_org": "DigitalOcean",
  "request_colo": "AMS",
  "request_user_agent": "OpenAI/Python 1.x"
}
```

`request_route` is one of:

- `gateway`, `git` or `github-api` for a sandbox-style request.
- `issuer-auth` or `admin-auth` for a canary presented as a role key.
- `renew` or `revoke` for management of a canary's ID.

**Delivery limits.**

- Each destination gets at most one alert an hour. Later trips inside that hour are recorded, then counted in the next alert as `trips_since_last_alert` and `canaries_tripped`.
- Delivery is a single attempt with a 10-second timeout and no retries. `alert list` shows each destination's last delivery and its HTTP status.
- `alert test` sends a `canary.test` event straight away, outside the hourly limit.

**Receivers.**

- **incident.io:** create an HTTP alert source with a custom payload. Set the deduplication key path to `$.dedup_key`, and map `title` and `status` in the transform. Add its events URL with an `Authorization: Bearer <source token>` header.
- **PagerDuty:** use a Custom Event Transformer integration that maps `title`, `severity` and `dedup_key`.

### Email alerts

Email alerts use [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/), which needs the Workers Paid plan and a domain on Cloudflare DNS.

1. In the Cloudflare dashboard, go to **Compute** > **Email Service** > **Email Sending**, select **Onboard Domain** and pick a subdomain such as `alerts.example.com`. Cloudflare adds its SPF, DKIM, DMARC and bounce records, which usually takes a few minutes. A subdomain keeps alert mail separate from your main domain's reputation.
2. Set `BROKER_EMAIL_FROM=canary@alerts.example.com` in `.env.deploy` and run `bun run deploy`. The deploy adds a `send_email` binding that may send only from that address.
3. Add a destination and check it: `bun run broker alert add email inbox --to oncall@example.com`, then `bun run broker alert test inbox`.

The subject is the alert title and the body lists the event's fields. `alert test` reports a send that Cloudflare accepts as accepted, not delivered, because it can still bounce; bounces show in the Email Service logs. `alert list` shows an accepted send as status 202 and a refused one as no answer. Clients older than this release don't list email destinations. Without `BROKER_EMAIL_FROM`, the broker has no binding and refuses `email` destinations.

## Observability and trust

Set `BROKER_OTLP_TRACES_ENDPOINT` to a trusted HTTPS OTLP/HTTP traces endpoint, such as `https://collector.example.com/v1/traces`, to export safe broker spans. If the collector needs authentication, supply the complete Authorization value in `BROKER_OTLP_AUTHORIZATION` as a Worker secret. Admin and issuer requests can propagate trusted W3C trace context. Issuance, renewal, listing, revocation and status each have a span. Admin spans use static operation names and status codes. Authorized gateway requests link to the issuing trace when available. The broker discards guest trace context and does not propagate broker trace headers to upstreams. Telemetry delivery is best effort. The deployment disables automatic invocation logging and native HTTP tracing to keep caller-supplied paths, query strings, and payloads out of telemetry.

Any sandbox workload or provider infrastructure able to read a grant can use it until expiry or revocation. Grants are bearer credentials scoped to integrations and are not bound to an IP address, sandbox identity, or private network. Keep them out of logs, artifacts, environment dumps, and persistent sandbox files. The registry stores token digests, expiry, grant scope, optional trace correlation, credential envelopes, Worker-secret references, sealed alert destinations, and canary trip records. Root encryption keys and role keys are Worker secret bindings. The Worker uses resolved upstream credentials only at the fixed provider endpoints. This deployment trusts its operators, Cloudflare, and the upstream providers.

## Validate locally

Run `bun run test` from the repository root. The suite uses Node.js 22 or later to run workerd on loopback with fixture upstreams. It uses local Git and GitHub CLI and creates a temporary loopback certificate with OpenSSL. They run without Cloudflare credentials or upstream API accounts. The hosted-tenant fixture uses its own directory binding, synthetic tenant hostnames, and fixture upstreams to exercise isolation, lifecycle operations, and the unchanged sandbox token format. Generate directory schema changes with `bun run --cwd services/credential-broker db:generate --config drizzle.directory.config.ts --name your_change`.
