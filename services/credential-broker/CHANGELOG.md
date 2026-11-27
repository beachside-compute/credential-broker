# @beachside-internal/credential-broker

## 0.4.0

### Minor Changes

- 6e69fa2: Enable optional tenant subdomains with per-tenant storage, role keys, and limits. Add `setConfig` to the admin client for updating a hosted tenant's configuration.
- 09fe74d: Add private, separately scoped control and operator RPC entrypoints, record sensitive platform operations, and require an explicit opt-in to platform HTTP.
- fc42ad3: Rotate tenant data keys with resumable ciphertext migration and a version-aware cache of non-exportable keys.
- 257a153: Accept short-lived, role-scoped tokens from configured issuers for hosted tenants and pinned self-hosted brokers.

### Patch Changes

- f4fcc71: `bun run deploy` keeps a saved `BEACHSIDE_BROKER_URL` that points at one of the Worker's custom domains instead of switching it back to `workers.dev`.

## 0.3.0

### Minor Changes

- 3434c11: Customize Wrangler settings for your own deployment without editing the tracked config: put them in `services/credential-broker/wrangler.local.jsonc` (ignored by git, see `wrangler.local.jsonc.example`) and `bun run deploy` merges its top-level keys over `wrangler.jsonc`. For example, add `routes` with `custom_domain: true` to serve the broker on your own hostname alongside `workers.dev`.

## 0.2.0

### Minor Changes

- bc21af2: Canary alerts can go to an email address through Cloudflare Email Service. Set `BROKER_EMAIL_FROM` to an address on a domain onboarded to Email Sending, run `bun run deploy`, then add a destination with `alert add email <id> --to <address>`. Deployments without `BROKER_EMAIL_FROM` are unchanged.

## 0.1.0

### Minor Changes

- a690765: Establish the first tagged release of the self-hosted credential broker Worker so operators can deploy a specific version and track upgrade requirements.
