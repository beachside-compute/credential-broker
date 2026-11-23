# Beachside credential broker

A self-hosted credential broker for AI sandboxes. The Worker stores encrypted upstream credentials and issues short-lived grants scoped to named integrations, so your real keys never reach the sandbox or the sandbox provider. The credential client and management CLI work with Beachside and standalone orchestrators.

## Install the agent skills

Install the broker's skills for your coding agent:

```sh
npx skills add beachside-compute/credential-broker --skill broker-setup --skill broker-grants
```

- [`broker-setup`](./skills/broker-setup/SKILL.md) guides a trusted operator through installing, deploying, and configuring the broker.
- [`broker-grants`](./skills/broker-grants/SKILL.md) guides a trusted launcher through issuing a short-lived grant, configuring the sandbox's tools, and revoking the grant when the job ends.

Inside the checkout the skills use `bun run deploy` and `bun run broker`; on other machines, the `beachside-broker` CLI from `@beachside/credential-client`. Sandboxes don't need the skills; they use their configured CLI or SDK as usual.

## Deploy

Use Bun 1.4.4 and Node.js 22 or later. From a clone of this repository:

1. Install dependencies and sign in to Cloudflare.

   ```sh
   bun install --frozen-lockfile
   bun run --cwd services/credential-broker wrangler login
   ```

   On a remote machine, run `bun run --cwd services/credential-broker wrangler login --device --browser=false`. Open the printed URL in your browser and enter the displayed code.

2. Optionally [configure a custom hostname](./services/credential-broker/README.md#use-a-custom-hostname) in `wrangler.jsonc`.

3. Deploy the broker for the first time.

   ```sh
   bun run deploy:setup
   ```

   Setup generates the admin, issuer and encryption keys in memory, uploads them as Worker secrets, and saves the broker's URL to `.env.deploy`. It prints the admin and issuer keys once. Save them in your password manager, then reference them from `.env.deploy`:

   ```dotenv
   BROKER_ADMIN_KEY=op://Private/beachside-broker/admin
   BROKER_ISSUER_KEY=op://Private/beachside-broker/issuer
   ```

   `bws://<secret-id>`, `pass://<path>` and `env:NAME` references work too. The encryption key is never shown, and the Worker holds its only lasting copy. Setup refuses to run against a Worker that already has any broker key, and outside a terminal it needs `--print-keys` so keys don't land in a log by accident.

Later deploys run `bun run deploy`. They update the code and settings such as `BROKER_CONFIG`, and never upload keys. For automated deployment, raw Wrangler commands, or local Worker development, see the [deployment runbook](./services/credential-broker/README.md#deploy).

## Add an OpenRouter key

Check the broker and your admin key.

```sh
bun run broker status
```

Run the integration setup command. Choose OpenRouter, press Enter to keep the ID `openrouter`, and enter its API key in the hidden prompt. Setup also lets the issuer mint grants for the new integration. Pass `--no-allow-issue` to allow it later with `issuer allow`.

```sh
bun run broker integration setup
```

The integration ID is the name a sandbox uses to request access. Use a unique ID such as `openrouter-team` when you add a second key for the same provider. The same command offers other model gateways and custom HTTPS endpoints. See the [endpoint runbook](./services/credential-broker/README.md#configurable-https-endpoints) for unattended setup.

The checkout command reads the URL and key references from `.env.deploy`. On another machine, install the CLI with `npm install -g @beachside/credential-client` and set `BEACHSIDE_BROKER_URL` with `BEACHSIDE_BROKER_ADMIN_KEY` or `BEACHSIDE_BROKER_ISSUER_KEY`. Each key can be the value or a reference such as `op://Private/beachside-broker/issuer`. When no key is configured, both commands ask for it at the terminal and use it for that run only. The Beachside CLI also runs these commands as `beachside broker ...` with keys from its config.

### Issue a grant

```sh
bun run broker grant issue openrouter --ttl 1h --label "my laptop test"
```

The output shows the grant ID, its expiry, the base URL for each integration, and the token. Use the base URL as the client's API base and the token as its API key. Grants last 15 minutes by default and up to 7 days (`--ttl 7d`). Add `--token` to print only the token, or `--json` for the full record. Keep the output private.

```sh
bun run broker grant list
bun run broker grant renew GRANT_ID --ttl 7d
bun run broker grant revoke GRANT_ID
```

`grant list` shows your issuer's active grants with their label, expiry and request count. `grant list --all` uses the admin key to show every grant on the broker.

### Rotate or invalidate access

Rotate an upstream credential while preserving its broker grants. Requests authorized after rotation use the replacement.

```sh
bun run broker integration rotate openrouter --credentials-stdin < /secure/path/replacement-headers.json
```

Stop new grants for an integration while existing grants keep working, or disable it to revoke them too.

```sh
bun run broker issuer deny openrouter
bun run broker integration disable openrouter
bun run broker integration enable openrouter
bun run broker issuer allow openrouter
```

To remove the integration entirely:

```sh
bun run broker integration delete openrouter
```

Deleting an integration also revokes its grants and removes it from the issuer allowlist. Requests already authorized may finish. Broker revocation leaves the upstream token active at GitHub or its provider. See the [deployment runbook](./services/credential-broker/README.md#manage-integrations) for lifecycle and key-rotation details.

### Command output

Commands print text for people and JSON with `--json`. Errors name the fix, for example `Integration openrouter is not allowed to issue grants. Allow it with ...`. Exit codes match the Beachside CLI: 0 success, 1 other failure, 2 usage, 3 not found, 5 authentication or permission, 6 outcome unknown (a write may have applied; check before retrying), 7 retryable.

## Use the client

![A sandbox calls the broker with a temporary grant. The broker swaps it for the upstream key, calls OpenRouter, and relays the response to the sandbox.](./docs/images/credential-broker-flow.png)

The root package exports `createCredentialBroker` and `createCredentialBrokerAdmin`. Call `broker.issue({ integrations, ttlSeconds, label })`, `broker.renew(grant.id, ttlSeconds)`, `broker.list()` and `broker.revoke(grant.id)` from a trusted host. Each grant lasts up to 7 days from its issuance or latest renewal, and renewal has no overall cap. `@beachside/credential-client/cli` exports `runBrokerCli` for tools that embed the commands. Administration and grant-management calls have a 10-second budget that includes reading the response body. A timed-out write may have reached the broker. A lost grant issuance, from a timeout or a dropped connection, fails with `TIMEOUT` (exit code 6, outcome unknown) because the grant may exist: check `broker.list()` before retrying. Such a grant remains until expiry or revocation. The issuer client can use a separate API key or [GitHub Actions OIDC](./services/credential-broker/README.md#authenticate-grant-issuance). The admin client manages integration and issuer policy metadata.

For Beachside integration, sandbox credential injection, GitHub CLI, OpenCode, and cleanup behavior, see the [Beachside credential broker guide](https://beachside.run/docs/credential-broker/).

`broker.sandbox()` builds the environment a sandbox needs. Pass integrations by ID and each one is set up from the kind the broker reports:

| Kind                                      | Variables in the sandbox                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `github`                                  | `git` and `gh` configuration (`GH_HOST`, `GH_ENTERPRISE_TOKEN`, `GIT_CONFIG_*`)                      |
| `anthropic`, `openai`, `openrouter`       | `ANTHROPIC_*`, `OPENAI_*` or `OPENROUTER_*`: `_BASE_URL` and `_API_KEY`                              |
| `http` (what `integration setup` creates) | `<ID>_BASE_URL` and `<ID>_API_KEY`, so `openrouter` sets `OPENROUTER_*` and `my-api` sets `MY_API_*` |

```ts
const credentials = broker.sandbox({ integrations: ["github", "openrouter"], ttlSeconds: 3_600 });
const grant = await credentials.acquire(AbortSignal.timeout(10_000));

// grant.env holds GH_HOST, GIT_CONFIG_*, OPENROUTER_BASE_URL and OPENROUTER_API_KEY.
// Pass it to the sandbox's environment, then revoke it when the sandbox is gone.
await grant.revoke(AbortSignal.timeout(10_000));
```

To pick other names, map the integration's gateway URL and temporary grant to the variables your API client reads.

```ts
const credentials = broker.sandbox({
  endpoints: [
    {
      integration: "openrouter",
      baseURLEnv: "OPENROUTER_BASE_URL",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  ],
});
```

The broker reports each integration's kind with the grant, so the base URL always matches what the client should call. The shorthand properties (`github`, `anthropic`, `openai`, `openrouter`) still work when you want to choose the variables yourself, for example to use an HTTP integration as `OPENROUTER_*`.

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
