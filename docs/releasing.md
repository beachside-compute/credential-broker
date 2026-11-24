# Release the credential broker and client

The public `@beachside/credential-client` package includes the `beachside-broker` executable. The private Worker under `services/credential-broker` has its own version and GitHub releases for self-hosted deployments.

## Prepare a version PR

1. Run `bun run changeset` for each user-visible change. Select the client, the Worker, or both, then choose the bump and write the release note. For the Worker, include any upgrade steps, database migrations, or client compatibility requirements.
2. Merge the feature PR with its changeset. **Prepare package versions** opens or updates the `chore: version packages` PR with each affected manifest and changelog. It dispatches CI on the version branch and verifies a frozen Bun install. To refresh it manually, run `gh workflow run version-prepare.yml --ref main`.
3. Review the versions and changelogs, then merge the version PR. A client version bump starts npm qualification. A Worker version bump starts Worker release qualification. A PR can release both independently.

The Changesets setup includes a Worker changeset for the initial `0.1.0` release.

## One-time setup

1. In GitHub Actions settings, allow GitHub Actions to create pull requests. Protect `main`. Allow the release workflows to create `v*` and `broker-v*` tags and prevent updates or deletions of existing release tags. Create the `npm` environment and allow deployments from `main` and `v*` tags. You can configure required reviewers for that environment. The npm workflow qualifies packages on GitHub-hosted runners with Bun 1.4.4, Node.js 24, and npm 11.15.0.
2. The package must already exist before npm can attach a trusted publisher. If it is new, have an authorized npm organization member with two-factor authentication perform a one-time public publish from the qualified tarball. Use the dry run below to produce that tarball. Reserve an unpublished version for the first OIDC release. [npm organization publishing](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/) · [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
3. In the package's npm settings, add a GitHub Actions trusted publisher. Set organization to `beachside-compute`, repository to `credential-broker`, workflow filename to `release-npm.yml`, and environment to `npm`. Enable direct `npm publish` in the allowed actions. Complete the first successful OIDC publish within two days of adding the configuration. The workflow uses GitHub OIDC for publication and npm attaches provenance for this public package. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

For a new package, download the qualified archive into a local directory before the one-time bootstrap. An authorized maintainer can publish a stable bootstrap version there. Use `--tag next` for a prerelease.

```sh
npm login --registry https://registry.npmjs.org
npm publish ./credential-client.tgz --access public --tag latest --registry https://registry.npmjs.org
```

## Qualify a client version

To qualify an already merged checkout without publishing, dispatch the release workflow on `main` or its matching `v<version>` tag. The workflow runs the offline checks and exercises the same tarball with Node and Bun consumers. Download the `credential-client-<version>-<attempt>` artifact from the workflow run to inspect the archive.

```sh
gh workflow run release-npm.yml --ref main -f dry_run=true
```

## Publish the client

Merging a version PR triggers release qualification for that version. After successful qualification, the workflow creates the matching Git tag if it is absent. The publish job uses the `npm` environment, waits for any configured approval, and publishes the qualified tarball after checking its checksum against the qualification job. Stable versions use `latest` and prereleases use `next`. A stable release that would move `latest` backwards fails.

If a version was already on `main` when the workflow was introduced, or if qualification completed and publication needs to be retried, dispatch a real release from the matching `v<version>` tag. For an already-current version with no release tag, use the commit SHA shown on the successful dry run to create and push the tag. The tag must point to a commit on `main` with the same package version and this workflow. The existing version is skipped only when the registry reports the same tarball integrity. A version with different published bytes requires a new version.

```sh
# Only when the release tag is absent. Set qualified_sha to the dry run's commit SHA.
git tag v0.2.0 "$qualified_sha"
git push origin refs/tags/v0.2.0

# For an existing matching tag, start here.
gh workflow run release-npm.yml --ref v0.2.0 -f dry_run=false
```

## Release and deploy the Worker

A Worker version bump runs an offline Wrangler bundle check, then creates a `broker-v<version>` tag and a GitHub Release with notes from `services/credential-broker/CHANGELOG.md`. The release is a source snapshot. Each operator deploys it to their own Cloudflare account using the [deployment runbook](../services/credential-broker/README.md#deploy).

To upgrade an existing deployment, read the release notes and use a checkout configured for that deployment.

```sh
git fetch --tags
git switch --detach broker-v0.1.0
bun install --frozen-lockfile
bun run deploy
```

To retry a failed Worker release, rerun the original workflow. If the tag already exists, you can also run `gh workflow run release-worker.yml --ref broker-v0.1.0` for that version.
