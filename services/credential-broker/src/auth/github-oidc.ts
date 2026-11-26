import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { z } from "zod";
import type { BrokerConfig } from "../config";
import type { Principal } from ".";

const issuer = "https://token.actions.githubusercontent.com";

const githubKeys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

const runId = z.string().regex(/^[1-9][0-9]{0,19}$/);

export async function githubActionsPrincipal(
  token: string,
  config: BrokerConfig,
): Promise<Principal | undefined> {
  if (!config.githubActions || token.split(".").length !== 3) return;

  try {
    if (decodeJwt(token).iss !== issuer) return;

    const { payload } = await jwtVerify(token, githubKeys, {
      issuer,
      audience: config.githubActions.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: 600,
    });

    if (payload.aud !== config.githubActions.audience) return;
    const run = runId.safeParse(payload.run_id);

    if (!run.success) return;

    const matching = config.githubActions.workflows.filter(
      (policy) =>
        payload.repository_id === policy.repositoryId &&
        payload.repository_owner_id === policy.repositoryOwnerId &&
        payload.repository === policy.repository &&
        payload.ref === policy.ref &&
        payload.workflow_ref === policy.workflowRef &&
        (policy.jobWorkflowRef === undefined
          ? payload.job_workflow_ref === undefined ||
            payload.job_workflow_ref === policy.workflowRef
          : payload.job_workflow_ref === policy.jobWorkflowRef) &&
        payload.event_name === policy.event,
    );

    if (!matching.length) return;

    return {
      owner: `github:${matching[0].repositoryId}:${run.data}`,
      integrations: [...new Set(matching.flatMap((rule) => rule.integrations))],
    };
  } catch {
    return;
  }
}
