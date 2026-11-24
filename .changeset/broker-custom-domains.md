---
"@beachside-internal/credential-broker": minor
---

Deployments can serve the broker on custom domains. Set `BROKER_CUSTOM_DOMAINS` to one or more comma-separated hostnames on a zone in the same Cloudflare account and run `bun run deploy`. The `workers.dev` URL keeps working, and deployments without the setting are unchanged.
