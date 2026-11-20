# Beachside credential broker

A self-hosted credential broker for AI sandboxes. The Worker stores encrypted upstream credentials and issues short-lived grants scoped to named integrations. The credential client and management CLI work with Beachside and standalone orchestrators.

## Deploy and configure

Use Bun 1.4.4 and Node.js 22 or later. From a clone of this repository, run:

```sh
bun install --frozen-lockfile
```

Set the Worker provisioning variables in the [deployment runbook](./services/credential-broker/README.md), then run `bun run deploy`. Use the Worker HTTPS origin in the client.

Build the CLI locally with `bun run build`. On the operator host, set `BEACHSIDE_BROKER_URL` and `BEACHSIDE_BROKER_ADMIN_KEY`. Pipe an upstream credential from a protected file or your secret manager:

```sh
node dist/cli.js integration create github-work --provider github --secret-stdin < /secure/path/github-token
node dist/cli.js issuer set github-work
node dist/cli.js integration list
```

The issuer allowlist starts empty. Setting it replaces the eligible integration set. CLI responses contain metadata. Keep the separate issuer key or GitHub Actions identity on the orchestrator.

### Rotate or invalidate access

Rotate an upstream credential while preserving its broker grants. Requests authorized after rotation use the replacement.

```sh
node dist/cli.js integration rotate github-work --secret-stdin < /secure/path/replacement-github-token
```

Disable the integration to revoke its broker grants. Re-enable it to allow fresh grants.

```sh
node dist/cli.js integration disable github-work
node dist/cli.js integration enable github-work
```

To remove the integration entirely:

```sh
node dist/cli.js integration delete github-work
```

Deleting an integration also revokes its grants and removes it from the issuer allowlist. Requests already authorized may finish. Broker revocation leaves the upstream token active at GitHub or its provider. See the [deployment runbook](./services/credential-broker/README.md#manage-integrations) for lifecycle and key-rotation details.

## Use the client

The root package exports `createCredentialBroker` and `createCredentialBrokerAdmin`. Call `broker.issue({ integrations, ttlSeconds })` and `broker.revoke(grant.id)` from a trusted host. Administration and grant-management calls have a 10-second budget that includes reading the response body. A timed-out write may have reached the broker. If a grant issuance response is lost, an issued grant remains until expiry or revocation. The issuer client can use a separate API key or [GitHub Actions OIDC](./services/credential-broker/README.md#authenticate-grant-issuance). The admin client manages integration and issuer policy metadata.

For Beachside integration, sandbox credential injection, GitHub CLI, OpenCode, and cleanup behavior, see the [Beachside credential broker guide](https://beachside.run/docs/guides/credential-broker/).

The package will publish independently of the Beachside SDK as `@beachside/credential-client`. To try an unreleased revision, build it in a clone and run `npm pack`. Install the resulting tarball in the consuming project. It includes JavaScript, TypeScript declarations, and the `beachside-broker` executable.

## Validate a change

```sh
bun run check
bun run lint
bun run format:check
bun run test
bun run package:smoke
```

Tests use Git, GitHub CLI, OpenSSL, and local workerd fixtures. CI runs the checks without deployment credentials. Before a client release, bump the root package version independently, refresh the lockfile, and run the checks and `npm pack --dry-run` from the repository root. Publication is a separate operator action.
