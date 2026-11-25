---
"@beachside-internal/credential-broker": patch
---

`bun run deploy` keeps a saved `BEACHSIDE_BROKER_URL` that points at one of the Worker's custom domains instead of switching it back to `workers.dev`.
