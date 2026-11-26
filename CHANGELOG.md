# @beachside/credential-client

## 0.6.0

### Minor Changes

- 6e69fa2: Enable optional tenant subdomains with per-tenant storage, role keys, and limits. Add `setConfig` to the admin client for updating a hosted tenant's configuration.

## 0.5.0

### Minor Changes

- bc21af2: Canary alerts can go to an email address through Cloudflare Email Service. Set `BROKER_EMAIL_FROM` to an address on a domain onboarded to Email Sending, run `bun run deploy`, then add a destination with `alert add email <id> --to <address>`. Deployments without `BROKER_EMAIL_FROM` are unchanged.
