# @beachside-internal/credential-broker

## 0.3.0

### Minor Changes

- 3434c11: Customize Wrangler settings for your own deployment without editing the tracked config: put them in `services/credential-broker/wrangler.local.jsonc` (ignored by git, see `wrangler.local.jsonc.example`) and `bun run deploy` merges its top-level keys over `wrangler.jsonc`. For example, add `routes` with `custom_domain: true` to serve the broker on your own hostname alongside `workers.dev`.

## 0.2.0

### Minor Changes

- bc21af2: Canary alerts can go to an email address through Cloudflare Email Service. Set `BROKER_EMAIL_FROM` to an address on a domain onboarded to Email Sending, run `bun run deploy`, then add a destination with `alert add email <id> --to <address>`. Deployments without `BROKER_EMAIL_FROM` are unchanged.

## 0.1.0

### Minor Changes

- a690765: Establish the first tagged release of the self-hosted credential broker Worker so operators can deploy a specific version and track upgrade requirements.
