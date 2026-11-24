---
"@beachside-internal/credential-broker": minor
---

Customize Wrangler settings for your own deployment without editing the tracked config: put them in `services/credential-broker/wrangler.local.jsonc` (ignored by git, see `wrangler.local.jsonc.example`) and `bun run deploy` merges its top-level keys over `wrangler.jsonc`. For example, add `routes` with `custom_domain: true` to serve the broker on your own hostname alongside `workers.dev`.
