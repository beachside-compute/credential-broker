# Release the credential client

The release workflow publishes the root `@beachside/credential-client` package and its `beachside-broker` executable. The Worker under `services/credential-broker` is private and deploys separately through Alchemy.

## One-time setup

1. In GitHub Actions settings, allow GitHub Actions to create pull requests. Protect `main`. Allow the workflow to create `v*` tags and prevent updates or deletions of existing release tags. Create the `npm` environment and allow deployments from `main` and `v*` tags. You can configure required reviewers for that environment. The workflow qualifies packages on GitHub-hosted runners with Bun 1.4.4, Node.js 24, and npm 11.15.0.
2. The package must already exist before npm can attach a trusted publisher. If it is new, have an authorized npm organization member with two-factor authentication perform a one-time public publish from the qualified tarball. Use the dry run below to produce that tarball. Reserve an unpublished version for the first OIDC release. [npm organization publishing](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/) · [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
3. In the package's npm settings, add a GitHub Actions trusted publisher. Set organization to `beachside-compute`, repository to `credential-broker`, workflow filename to `release-npm.yml`, and environment to `npm`. Enable direct `npm publish` in the allowed actions. Complete the first successful OIDC publish within two days of adding the configuration. The workflow uses GitHub OIDC for publication and npm attaches provenance for this public package. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

For a new package, download the qualified archive into a local directory before the one-time bootstrap. An authorized maintainer can publish a stable bootstrap version there. Use `--tag next` for a prerelease.

```sh
npm login --registry https://registry.npmjs.org
npm publish ./credential-client.tgz --access public --tag latest --registry https://registry.npmjs.org
```

## Prepare and qualify a version

Run the version workflow on `main` to open or reuse its version PR. Pass a version greater than the current version without a `v` prefix. The PR updates the public package manifest. Bun omits the root workspace version in its lockfile, so the workflow verifies a frozen install and leaves dependency resolutions unchanged. The workflow dispatches CI on the version branch to avoid waiting for approval of bot-opened PR workflow runs.

```sh
gh workflow run version-prepare.yml --ref main -f version=0.2.0
```

To qualify an already merged checkout without publishing, dispatch the release workflow on `main` or its matching `v<version>` tag. The workflow runs the offline checks and exercises the same tarball with Node and Bun consumers. Download the `credential-client-<version>-<attempt>` artifact from the workflow run to inspect the archive.

```sh
gh workflow run release-npm.yml --ref main -f dry_run=true
```

## Publish

Merging a version PR triggers release qualification for that version. After successful qualification, the workflow creates the matching Git tag if it is absent. The publish job uses the `npm` environment, waits for any configured approval, and publishes the qualified tarball after checking its checksum against the qualification job. Stable versions use `latest` and prereleases use `next`. A stable release that would move `latest` backwards fails.

If a version was already on `main` when the workflow was introduced, or if qualification completed and publication needs to be retried, dispatch a real release from the matching `v<version>` tag. For an already-current version with no release tag, use the commit SHA shown on the successful dry run to create and push the tag. The tag must point to a commit on `main` with the same package version and this workflow. The existing version is skipped only when the registry reports the same tarball integrity. A version with different published bytes requires a new version.

```sh
# Only when the release tag is absent. Set qualified_sha to the dry run's commit SHA.
git tag v0.2.0 "$qualified_sha"
git push origin refs/tags/v0.2.0

# For an existing matching tag, start here.
gh workflow run release-npm.yml --ref v0.2.0 -f dry_run=false
```
