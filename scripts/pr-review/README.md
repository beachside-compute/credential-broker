# PR reviews

Credential Broker uses the [Beachside PR review recipe](https://beachside.run/docs/recipes/pr-review/).
The [review workflow](../../.github/workflows/pr-review.yml) runs when an owner, member, or
collaborator opens a same-repository PR targeting the default branch or marks it ready.
Pi reads the diff in a Freestyle sandbox and posts one comment-only review with inline
findings. The runner checks out the default branch, and Pi starts outside the PR checkout
so it does not load project settings from the PR.

The [maintenance workflow](../../.github/workflows/pr-review-maintenance.yml) builds a
weekly snapshot and sweeps Credential Broker review sandboxes older than an hour. Sandboxes and
broker grants expire after 30 minutes. If the snapshot is missing or expired, the reviewer
installs its tools on the base image.

## Repository settings

| Kind     | Name                        | Value                                                      |
| -------- | --------------------------- | ---------------------------------------------------------- |
| Secret   | `FREESTYLE_API_KEY`         | Freestyle API key for review and maintenance.              |
| Variable | `BEACHSIDE_BROKER_URL`      | HTTPS origin of the credential broker.                     |
| Variable | `BEACHSIDE_BROKER_AUDIENCE` | The broker's GitHub Actions OIDC audience.                 |
| Variable | `PR_REVIEW_ENABLED`         | Set to `true` to enable both workflows.                    |
| Variable | `PR_REVIEW_GATEWAY`         | Credential Broker uses `kilo`, which is also the default.  |
| Variable | `PR_REVIEW_MODEL`           | Optional override for `deepseek/deepseek-v4.1-flash-1017`. |

The runner uses GitHub Actions OIDC to obtain a short-lived grant. The broker's GitHub
integration needs Contents read and Pull requests write for Credential Broker. Add this rule to
the existing `githubActions.workflows` array in the broker configuration and keep its
existing audience.

```json
{
  "repositoryId": "1464816348",
  "repositoryOwnerId": "353477479",
  "repository": "beachside-compute/credential-broker",
  "ref": "refs/heads/main",
  "workflowRef": "beachside-compute/credential-broker/.github/workflows/pr-review.yml@refs/heads/main",
  "event": "pull_request_target",
  "integrations": ["github-review", "kilo"]
}
```

Once the workflows are on the default branch, run **PR review maintenance** manually to
warm the cache ahead of its next scheduled build.

Run `bun test test/pr-review.test.ts` to exercise the reviewer and cleanup selection with a
fake sandbox.
