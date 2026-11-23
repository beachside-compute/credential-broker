---
name: broker-grants
description: Issue and revoke short-lived Beachside credential broker grants from a trusted launcher. Use when configuring CI or an orchestrator to inject credentials into a sandbox.
---

# Issue grants from the trusted launcher

Use this skill in the host or CI job that launches the sandbox. The sandbox gets the temporary tool environment and can use its configured CLI or SDK normally. Keep admin and issuer credentials, GitHub Actions OIDC request variables, and the rest of the host environment on the trusted side.

1. Identify the broker origin, exact integration IDs, and expected job duration. Request only the integrations the workload needs. Use a short TTL that covers the job, such as 900 seconds for a 15-minute task.
2. For static issuance, use the installed `beachside-broker` CLI on the trusted host. Install it with `npm install -g @beachside/credential-client` if needed. Set `BEACHSIDE_BROKER_URL` and provide `BEACHSIDE_BROKER_ISSUER_KEY` from the trusted host's secret store.

   ```sh
   beachside-broker grant issue INTEGRATION_ID --ttl 15m --label "sandbox job"
   beachside-broker grant revoke GRANT_ID
   ```

   Capture issuance output privately and revoke after the workload exits. For scripts, add `--json` and capture stdout directly in the launcher. Use the grant ID for cleanup and map the token and gateway URL to the sandbox's tool configuration. For GitHub tool configuration, see the client examples below.

3. For a GitHub Actions workflow authorized via OIDC, use the [TypeScript client](https://www.npmjs.com/package/@beachside/credential-client). The CLI uses a static issuer key. Install the client in the launcher project with `npm install @beachside/credential-client`. Give the trusted job `id-token: write` and use the exact audience from its [broker policy](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#authenticate-grant-issuance). Keep PR-controlled code, actions, and artifacts out of that job.

   Replace `openrouter` with the intended integration ID and implement `runSandboxAndWait` with the project's launcher. It must return after the workload exits and handle sandbox teardown on failure.

   ```ts
   import { createCredentialBroker, githubActionsOidc } from "@beachside/credential-client";

   const url = process.env.BEACHSIDE_BROKER_URL;
   const audience = process.env.BROKER_OIDC_AUDIENCE;
   if (!url || !audience) throw new Error("Configure the broker URL and OIDC audience");

   const broker = createCredentialBroker({
     url,
     auth: githubActionsOidc({ audience, env: process.env }),
   });

   const grant = await broker
     .sandbox({ integrations: ["openrouter"], ttlSeconds: 900, label: "sandbox job" })
     .acquire(AbortSignal.timeout(10_000));

   try {
     await runSandboxAndWait({ env: grant.env });
   } finally {
     await grant.revoke(AbortSignal.timeout(10_000));
   }
   ```

   Pass only `grant.env` and explicitly selected nonsecret settings to the sandbox. Keep grant data out of logs and artifacts.

4. A timed-out issuance may have succeeded. List active grants under the same issuer before retrying. Revocation uses the original issuing identity, so clean up an OIDC grant within the same workflow run. Expiry bounds access if the launcher is interrupted before cleanup. If the original issuer is unavailable and immediate containment is needed, an operator can disable the integration. That revokes every grant that includes it.

See the [client examples](https://github.com/beachside-compute/credential-broker#use-the-client) for the environment variables the client injects for GitHub and API integrations.
