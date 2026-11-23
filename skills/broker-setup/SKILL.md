---
name: broker-setup
description: Set up, deploy, or update the Beachside credential broker on Cloudflare Workers. Use when an operator needs to configure a broker, add an upstream integration, or set its issuance policy.
---

# Set up the Beachside credential broker

Work from a trusted operator environment. Use the [deployment runbook](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md) in the checkout's revision for deployment and integration details.

1. Confirm the target Cloudflare account, Worker name, intended integrations, and whether this is a first deploy or an update. Use Bun 1.4.4 and Node.js 22 or later.
2. Use an existing checkout or clone it with `git clone https://github.com/beachside-compute/credential-broker.git` and enter the checkout. Install the locked dependencies and use Wrangler to authenticate and verify the account.

   ```sh
   bun install --frozen-lockfile
   bun run --cwd services/credential-broker wrangler login
   bun run --cwd services/credential-broker wrangler whoami
   bun run deploy --dry-run
   ```

3. For an authorized first deployment, have the operator run `bun run deploy:setup` in a private terminal. It prints the admin and issuer keys once and saves the broker URL to `.env.deploy`. Have the operator save the keys in a password manager and put references under `BROKER_ADMIN_KEY` and `BROKER_ISSUER_KEY` in that file. Supported references include `op://`, `bws://`, `pass://`, and `env:NAME`. The Worker holds the encryption key. For an authorized update to an existing Worker, use `bun run deploy`.
4. Check the broker and add the intended upstream credential through the wizard's hidden prompt. Review the integration before adding it to the issuance allowlist.

   ```sh
   bun run broker status
   bun run broker integration setup --no-allow-issue
   bun run broker integration list
   bun run broker issuer allow INTEGRATION_ID
   bun run broker issuer show
   ```

   Replace `INTEGRATION_ID` with the reviewed integration's ID. Use a credential scoped to the repositories, operations, or provider limits the workload needs. GitHub grants inherit the upstream credential's Git and GraphQL permissions. Configure custom HTTPS integrations only for trusted upstreams that keep credentials out of their responses.

5. For GitHub Actions, configure the exact trusted workflow and its integration IDs in `BROKER_CONFIG.githubActions` using the runbook's [OIDC policy example](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#authenticate-grant-issuance). Use a deployment-specific audience. The workflow policy and the issuance allowlist must both permit the integration.
6. Verify with `bun run broker status` and `bun run broker issuer show`. If the operator requests an issuance check, use the `broker-grants` workflow from the trusted launcher with a short TTL and revoke the test grant after verification.

Keep Cloudflare credentials, broker role keys, upstream credentials, and grant tokens out of chat, agent tool output, logs, and committed files. Report the broker URL, integration IDs, and verification results to the operator.
