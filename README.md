# Beachside credential broker

A self-hosted credential broker for AI sandboxes. The Worker stores encrypted upstream credentials and issues short-lived grants scoped to named integrations. The credential client and management CLI work with Beachside and standalone orchestrators.

## Deploy

Use Bun 1.4.4 and Node.js 22 or later. From a clone of this repository:

1. Install dependencies and sign in to Cloudflare.

   ```sh
   bun install --frozen-lockfile
   bun run --cwd services/credential-broker wrangler login
   ```

   On a remote machine, run `bun run --cwd services/credential-broker wrangler login --device --browser=false`. Open the printed URL in your browser and enter the displayed code.

2. Generate separate admin, issuer, and encryption keys in `.env.deploy`. Keep this file private and back up its keys securely. Rerunning setup keeps an existing file.

   ```sh
   bun run deploy:setup
   ```

3. Optionally [configure a custom hostname](./services/credential-broker/README.md#use-a-custom-hostname) in `wrangler.jsonc`.

4. Deploy and copy the HTTPS URL Wrangler prints.

   ```sh
   bun run deploy
   ```

Use `bun run deploy:alchemy` for an existing Alchemy deployment. For automated deployment, raw Wrangler commands, or local Worker development, see the [deployment runbook](./services/credential-broker/README.md#deploy).

## Add an OpenRouter key

From the deployment checkout, run the integration setup command with the HTTPS origin printed by Wrangler. Choose OpenRouter, name the integration `router-work`, and enter its API key in the hidden prompt.

```sh
bun run broker --url https://your-broker.example.com integration setup
```

The command loads the admin key from `.env.deploy`. Add `BEACHSIDE_BROKER_URL=https://your-broker.example.com` to that file with your deployed URL so later commands can omit `--url`.

Check which integrations the issuer can use.

```sh
bun run broker issuer show
```

If the list is empty, allow grants for `router-work`.

```sh
bun run broker issuer set router-work
```

If the list already contains IDs, pass them alongside `router-work` to keep them. The same setup command also offers other providers and custom HTTPS endpoints. See the [endpoint runbook](./services/credential-broker/README.md#configurable-https-endpoints) for unattended setup and rotation.

### Rotate or invalidate access

Rotate an upstream credential while preserving its broker grants. Requests authorized after rotation use the replacement.

```sh
bun run broker integration rotate router-work --credentials-stdin < /secure/path/replacement-headers.json
```

Disable the integration to revoke its broker grants. Re-enable it to allow fresh grants.

```sh
bun run broker integration disable router-work
bun run broker integration enable router-work
```

To remove the integration entirely:

```sh
bun run broker integration delete router-work
```

Deleting an integration also revokes its grants and removes it from the issuer allowlist. Requests already authorized may finish. Broker revocation leaves the upstream token active at GitHub or its provider. See the [deployment runbook](./services/credential-broker/README.md#manage-integrations) for lifecycle and key-rotation details.

## Use the client

![A sandbox calls the broker with a temporary grant. The broker swaps it for the upstream key, calls OpenRouter, and relays the response to the sandbox.](./docs/images/credential-broker-flow.png)

The root package exports `createCredentialBroker` and `createCredentialBrokerAdmin`. Call `broker.issue({ integrations, ttlSeconds })` and `broker.revoke(grant.id)` from a trusted host. Administration and grant-management calls have a 10-second budget that includes reading the response body. A timed-out write may have reached the broker. If a grant issuance response is lost, an issued grant remains until expiry or revocation. The issuer client can use a separate API key or [GitHub Actions OIDC](./services/credential-broker/README.md#authenticate-grant-issuance). The admin client manages integration and issuer policy metadata.

For Beachside integration, sandbox credential injection, GitHub CLI, OpenCode, and cleanup behavior, see the [Beachside credential broker guide](https://beachside.run/docs/guides/credential-broker/).

For a configurable HTTP integration, map its gateway URL and temporary grant to the environment variables your API client reads.

```ts
const credentials = broker.sandbox({
  endpoints: [
    {
      integration: "router-work",
      baseURLEnv: "OPENROUTER_BASE_URL",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  ],
});
```

If `router-work` has upstream base URL `https://openrouter.ai/api/v1`, the sandbox base URL ends at `/gateway/router-work`. Set the client to use that URL as its API base.

For OpenCode v2, set the provider’s `baseURL` to the broker endpoint and its `apiKey` to the temporary grant. `OPENCODE_CONFIG_CONTENT` takes the nested JSON shown in the [OpenCode configuration example](./services/credential-broker/README.md#opencode).

![OpenCode v2 OpenRouter settings use {env:OPENROUTER_BASE_URL} for baseURL and {env:OPENROUTER_API_KEY} for apiKey.](./docs/images/opencode-broker-configuration.png)

The npm package `@beachside/credential-client` releases independently of the Beachside SDK. To try an unreleased revision, build it in a clone and run `npm pack`. Install the resulting tarball in the consuming project. It includes JavaScript, TypeScript declarations, and the `beachside-broker` executable.

## Validate a change

```sh
bun run check
bun run lint
bun run format:check
bun run test
bun run package:smoke
```

Tests use Git, GitHub CLI, OpenSSL, and local workerd fixtures. CI runs the checks without deployment credentials. The [release workflow](./docs/releasing.md) versions and publishes the public client independently of the Worker.
