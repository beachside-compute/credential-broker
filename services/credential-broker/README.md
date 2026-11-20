# Beachside credential broker

The broker lets a sandbox use GitHub over HTTPS or call HTTPS APIs with expiring grants. Deploy it in your Cloudflare account. A SQLite-backed Durable Object stores the integration catalog, encrypted credentials, issuer permissions, and the grant registry. The Worker authorizes every request and supplies the selected credential to the fixed upstream. A sandbox receives only a grant and instructions for reaching the broker.

## Deploy

Use Bun 1.4.4, Node.js 22 or later, and a Cloudflare account with permission to create a Worker, Worker secrets, and a SQLite Durable Object namespace. Run these commands from the repository root.

```sh
bun install --frozen-lockfile
bun run --cwd services/credential-broker wrangler login
bun run deploy:setup
bun run deploy
```

For a remote terminal, use `bun run --cwd services/credential-broker wrangler login --device --browser=false`. Open the printed URL in your browser and enter the displayed code. [Wrangler login options](https://developers.cloudflare.com/workers/wrangler/commands/general/#wrangler-login).

`bun run deploy:setup` generates independent admin, issuer, and encryption keys in `.env.deploy` with mode `0600`. It runs without a terminal and leaves an existing private file unchanged. Keep secure backups of the keys for as long as the registry or its backups may need them. For unattended deployment, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` alongside your broker settings. [Wrangler permissions and API token authentication](https://developers.cloudflare.com/workers/authorization/).

`bun run deploy` reuses your deployment settings and passes them to Wrangler. Run `bun run deploy --dry-run` to check the Worker bundle offline.

### Use a custom hostname

Before deploying, add a `routes` entry to [`wrangler.jsonc`](./wrangler.jsonc). Choose a hostname in a Cloudflare zone on the account you deploy to. Set `workers_dev` to `false` to disable the default `workers.dev` hostname. [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

```jsonc
"routes": [{ "pattern": "broker.example.com", "custom_domain": true }],
"workers_dev": false
```

### Configure deployment bindings

For manual setup, use the [deployment template](../../.env.deploy.example) and give the resulting `.env.deploy` file mode `0600`. You can also supply the settings through exported environment variables. The file takes precedence for values it sets. The runtime `.dev.vars` file is for local development.

| Variable                                                      | Value                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `BROKER_ADMIN_KEY`                                            | Required management bearer key. Generate it from at least 32 random bytes and encode it as base64url.                                      |
| `BROKER_ISSUER_KEY`                                           | Optional static grant-issuance bearer key. Generate it independently of the admin key.                                                     |
| `BROKER_ENCRYPTION_KEYS`                                      | Required JSON object mapping encryption key versions to unpadded base64url encodings of 32 independently generated random bytes each.      |
| `BROKER_ENCRYPTION_KEY_VERSION`                               | Required active key version. Use a 1–32 character label made of letters, digits, hyphens, or underscores, starting with a letter or digit. |
| `BROKER_CONFIG`                                               | Optional JSON for GitHub Actions trust policies and declared Worker secret bindings. Defaults to an empty object.                          |
| `CREDENTIAL_…`                                                | Upstream keys for optional Worker-secret integrations named in `BROKER_CONFIG.workerSecretBindings`.                                       |
| `BROKER_OTLP_TRACES_ENDPOINT` and `BROKER_OTLP_AUTHORIZATION` | Optional trace endpoint and collector authorization.                                                                                       |
| `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`            | Optional provisioning credentials and account selection for Wrangler automation.                                                           |

Configure a static issuer key, GitHub Actions OIDC, or both. The admin, issuer, and encryption keys must be distinct. The API keys use 32–256 base64url characters and exclude the reserved sandbox grant token format.

The deployment command passes only Worker bindings to Wrangler in a private temporary secrets file and removes it after the command completes. It uploads `BROKER_CONFIG` and `BROKER_ENCRYPTION_KEY_VERSION` as Worker secret bindings so the deployment settings take precedence over the defaults in `wrangler.jsonc`.

Wrangler preserves previously deployed secrets omitted from a later upload. To remove an optional binding such as the static issuer key or OTLP authorization, remove it from your deployment settings and explicitly delete it from the same Worker. For example, configure GitHub Actions OIDC before removing the static issuer key. [Wrangler secret removal](https://developers.cloudflare.com/workers/configuration/secrets/#delete-secrets-from-your-project).

```sh
bun run --cwd services/credential-broker wrangler secret delete BROKER_ISSUER_KEY
```

Use the HTTPS origin Wrangler prints in the client. The Durable Object applies pending migrations on startup. After schema changes, run `bun run --cwd services/credential-broker db:generate --name your_change` and commit its SQL, journal, snapshot, and bundled migration index. A new deployment begins with an empty integration catalog and issuer allowlist.

### Update an Alchemy deployment

Run `bun run deploy:alchemy` to retain an existing Alchemy-managed Worker and registry. Restore the original broker keys and `ALCHEMY_PASSWORD` through `.env.deploy` or your secret manager. Keep the same Alchemy stage and state directory and use its existing Cloudflare profile or provisioning credentials. The passphrase protects Alchemy state. The default command directs detected Alchemy deployments to the explicit Alchemy command.

### Deploy directly with Wrangler

Use `bun run deploy:wrangler` to manage Wrangler arguments and Worker secrets yourself. The [Wrangler configuration](./wrangler.jsonc) creates the `beachside-credential-broker` Worker and its SQLite-backed grant registry. Its regular variables default to version `v1` and an empty `BROKER_CONFIG`. Supply custom runtime settings in the configuration or as secret bindings. Use the same deployment path when updating the Worker and registry.

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
BEACHSIDE_BROKER_URL=http://localhost:8787 BEACHSIDE_BROKER_ADMIN_KEY=LOCAL_ADMIN_KEY bun run broker status
```

## Manage integrations

From the deployment checkout, save the HTTPS origin printed by Wrangler as `BEACHSIDE_BROKER_URL` in `.env.deploy`, then open the integration setup wizard. Choose OpenRouter, keep the ID `openrouter`, and enter its upstream API key when prompted. The command runs the management CLI with the admin key from `.env.deploy`, and lets the issuer mint grants for the new integration unless you pass `--no-allow-issue`.

```sh
bun run broker status
bun run broker integration setup
```

The integration ID is the name a sandbox uses to request access. Enter a unique ID for a second key of the same provider. Add `--json` to write the integration metadata to stdout. You can also pass `--url` for one command, or set `BEACHSIDE_BROKER_URL` and `BEACHSIDE_BROKER_ADMIN_KEY` in the environment. The separately installed `beachside-broker` CLI and `beachside broker` in the Beachside CLI run the same commands.

The issuance allowlist decides which integrations the issuer can mint grants for. `integration create --allow-issue` and the setup wizard add the new integration. Change it one ID at a time, or replace the whole list.

```sh
bun run broker issuer show
bun run broker issuer allow openrouter
bun run broker issuer deny openrouter
bun run broker issuer set openrouter github-work
```

`integration list` shows each integration's state, whether it is allowed to issue, its upstream and credential version. `config show` prints the GitHub Actions trust policy from `BROKER_CONFIG`.

### Issue and manage grants

```sh
bun run broker grant issue openrouter --ttl 12h --label "sandbox web"
bun run broker grant list
bun run broker grant renew GRANT_ID --ttl 7d
bun run broker grant revoke GRANT_ID
```

Use the base URL for each integration as the client's API base and the token as its API key. The broker reports each integration's kind, so the URL already maps to the upstream base for built-in and configurable integrations. Grants default to 15 minutes. `--ttl` takes seconds or a number with `s`, `m`, `h` or `d`, up to `7d`. `--token` prints only the token and `--json` the full record. Keep the output private.

`grant list` shows the issuer's active grants with label, expiry, request count and last use. `grant list --all` uses the admin key to show every grant and its issuing authority. Grant commands use `BROKER_ISSUER_KEY` from `.env.deploy`. For the installed CLI, set `BEACHSIDE_BROKER_URL` and `BEACHSIDE_BROKER_ISSUER_KEY`.

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

To rotate one or more headers, pipe in a JSON map that contains only the replacement values. The admin rotate API receives `{ "source": "encrypted-store", "values": {...} }`. Use `--secret-stdin` or `--worker-secret` for the built-in kinds. Omitted HTTP secret headers keep their current values and existing grants remain valid. For root key rotation, provide every secret value from its original source or rotate it to a fresh upstream value. An endpoint with no secret headers can be re-encrypted with an empty map.

```sh
node dist/cli.js integration rotate gateway-work --credentials-stdin < /secure/path/replacement-headers.json
```

A grant can call HTTP paths beneath the configured base. For example, a request to `/gateway/gateway-work/chat/completions` reaches `/v1/ACCOUNT_ID/GATEWAY_ID/openai/chat/completions` on the Cloudflare gateway. Use a bearer grant or `x-api-key`, with one authentication header per request. The broker consumes the grant header and strips hop-by-hop, forwarding, client identity, cookie, and known tracing headers, including `traceparent`, `baggage`, `sentry-trace`, `grpc-trace-bin`, and the `x-b3-*` and `x-datadog-*` families. It also strips guest `cf-*` headers. Administrators can configure `cf-aig-*` headers. Configured headers replace guest values. Ordinary application headers such as `x-request-id` and `x-correlation-id` pass through as application data. Configure provider-side scopes and limits for all methods and paths the upstream exposes. Trust the endpoint to keep injected values out of its response bodies, where the broker streams the upstream bytes directly.

The broker blocks redirects, WebSocket upgrades, and CONNECT, TRACE, and TRACK. Paths reject encoded separators, double slashes, matrix parameters, and segments ending in a dot or whitespace. The HTTP gateway supports server-sent events and streaming bodies. Response filtering removes cookies, redirect targets, and configured secret header names. It also removes headers that match a raw secret, contain a prefixed secret, or contain a raw secret of at least eight characters. This filtering is best effort. Use trusted upstreams that keep credentials out of responses.

### Rotate an encryption key

Deploy `BROKER_ENCRYPTION_KEYS` with both the previous and new keys while keeping the old version active. After that deployment has rolled out, switch `BROKER_ENCRYPTION_KEY_VERSION` to the new version and deploy again. Rotate each encrypted integration using its upstream credential from the original source or a new upstream credential. Every successful rotation writes with the active version and a fresh nonce. Remove a previous key from the Worker only after rotating the integrations encrypted with it. Keep secure recovery copies for as long as database backups may contain those ciphertexts. Losing an old key makes records written with it unrecoverable. Always use a new label for new key material.

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

Give the trusted orchestration job `id-token: write` and request a token for the configured audience. Pick an audience unique to the deployment. The [credential client](../../README.md) can request the token from the runner. The broker verifies GitHub's signature, issuer, exact audience, expiry, token age, repository and owner IDs, repository name, workflow path and ref, and event. A matching workflow can revoke grants issued within its repository workflow run.

Supported events are `push`, `schedule`, `workflow_dispatch`, `workflow_run`, and `pull_request_target`. For a reusable workflow, configure the called workflow's exact `jobWorkflowRef`. For a direct job, omit it. The broker accepts an absent `job_workflow_ref` or one that matches `workflowRef`. Trust refs controlled by your operators. For `pull_request_target` and `workflow_run`, keep PR-controlled code, actions, scripts, and artifacts out of the orchestration job. Run untrusted work inside the sandbox after issuing its limited grant.

## Grant API

| Request                     | Result                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/grants`           | Create a grant with body `{ "integrations": ["github-work"], "ttlSeconds": 900, "label": "sandbox web" }` (`label` is optional). The response is `201` and has `id`, `token`, `expiresAt` (ISO 8601), `integrations`, and `kinds` (each integration's kind). A refused integration returns `403` with `reason` (`not_found`, `disabled`, `not_allowlisted` or `not_in_policy`) and the `integrations` it names. |
| `DELETE /v1/grants/:id`     | Revoke under the issuing workflow run or static issuer key. Repeated requests return `204`.                                                                                                                                                                                                                                                                                                                     |
| `POST /v1/grants/:id/renew` | Body `{ "ttlSeconds": 604800 }`. Moves an active grant's expiry. Returns the grant summary, or `404 grant_not_found` for an expired, revoked or foreign grant.                                                                                                                                                                                                                                                  |
| `GET /v1/grants`            | Returns `{ "grants": [...] }`: the caller's active grants with `id`, `integrations`, `label`, `createdAt`, `expiresAt`, `requests` and `lastUsedAt`. Tokens are never listed.                                                                                                                                                                                                                                   |
| `GET /v1/status`            | With the admin, issuer or a workflow token. Returns `apiVersion`, `role`, `limits.maxGrantTtlSeconds`, and for the admin key integration and grant counts.                                                                                                                                                                                                                                                      |

Grants last between 1 second and 7 days (604,800 seconds). An issuer can renew its own active grant to a new lifetime of up to 7 days from the renewal, keeping its token and scope. A grant can use its selected integrations immediately and cannot manage grants. The operation is authorized again for every gateway request. Revocation and expiry reject new requests. Requests that have already passed authorization, including active model streams and writes, may finish. A lost response to grant creation may leave a record until its expiry, and the broker cannot recover the raw grant token.

By default the registry admits up to 1,000 active grants and up to 100 per issuing authority (one static issuer role or one workflow run). Each grant allows 120 requests per UTC minute and eight concurrent gateway requests, including streams. A lost lease release can occupy a slot until expiry. A request over a bound receives HTTP `429`. Set provider-side token scopes, spend limits, and quotas to constrain delegated use.

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

## Observability and trust

Set `BROKER_OTLP_TRACES_ENDPOINT` to a trusted HTTPS OTLP/HTTP traces endpoint, such as `https://collector.example.com/v1/traces`, to export safe broker spans. If the collector needs authentication, supply the complete Authorization value in `BROKER_OTLP_AUTHORIZATION` as a Worker secret. Admin and issuer requests can propagate trusted W3C trace context. Admin spans use static operation names and status codes. Authorized gateway requests link to the issuing trace when available. The broker discards guest trace context and does not propagate broker trace headers to upstreams. Telemetry delivery is best effort. The deployment disables automatic invocation logging and native HTTP tracing to keep caller-supplied paths, query strings, and payloads out of telemetry.

Any sandbox workload or provider infrastructure able to read a grant can use it until expiry or revocation. Grants are bearer credentials scoped to integrations and are not bound to an IP address, sandbox identity, or private network. Keep them out of logs, artifacts, environment dumps, and persistent sandbox files. The registry stores token digests, expiry, grant scope, optional trace correlation, credential envelopes, and Worker-secret references. Root encryption keys and role keys are Worker secret bindings. The Worker uses resolved upstream credentials only at the fixed provider endpoints. This deployment trusts its operators, Cloudflare, and the upstream providers.

## Validate locally

Run `bun run test` from the repository root. The suite uses Node.js 22 or later to run workerd on loopback with fixture upstreams. It uses local Git and GitHub CLI and creates a temporary loopback certificate with OpenSSL. They run without Cloudflare credentials or upstream API accounts.
