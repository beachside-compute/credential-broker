# Working on the credential broker

The repository root contains the public TypeScript credential client and management CLI. The private Worker, its SQLite schema and migrations, and its Wrangler configuration live in `services/credential-broker`. The user guide lives in [Beachside's documentation](https://beachside.run/docs/guides/credential-broker/).

Keep admin, issuer, and sandbox authentication separate. Resolve upstream credentials only after per-request grant authorization and send them only to fixed, administrator-configured upstreams. Keep plaintext credentials and role keys out of SQLite, logs, spans, errors, and committed files. Review the local fixture and operator docs when changing the wire contract or storage.

Use Bun 1.4.4 and Node.js 22 or later. Install with `bun install --frozen-lockfile`. Run `bun run check`, `bun run lint`, `bun run format:check`, `bun run test`, and `bun run package:smoke` for affected changes. Tests use local Git, GitHub CLI, OpenSSL, and workerd with offline fixture upstreams. Preserve the vendored lint rules and their provenance when updating the plugin.

Deployments, live provider calls, and npm publication require explicit authorization.
