---
"@beachside-internal/credential-broker": minor
---

Serve the broker on your own hostnames: set `BROKER_CUSTOM_DOMAINS=gateway.example.com` (comma-separated) in `.env.deploy` and `bun run deploy` attaches them as Cloudflare Custom Domains alongside `workers.dev`. The zone must be in the same Cloudflare account. Deployments without the setting are unchanged.
