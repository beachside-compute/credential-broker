import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@beachside/credential-client";

const registry = "https://registry.npmjs.org";

const semver =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function versionTag(version) {
  const match = semver.exec(version ?? "");

  if (
    !match ||
    version.length > 128 ||
    !match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) ||
    match[4]?.split(".").some((part) => /^0[0-9]+$/.test(part))
  )
    throw new Error("Expected an npm release version without a v prefix or build metadata");

  return match[4] ? "next" : "latest";
}

function clientManifest(text) {
  const manifest = JSON.parse(text);

  assert.equal(manifest.name, packageName);
  assert.equal(manifest.private, false);
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  versionTag(manifest.version);

  return manifest;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function prepareVersion(version) {
  versionTag(version);
  const manifest = clientManifest(readFileSync("package.json", "utf8"));
  assert.ok(Bun.semver.order(version, manifest.version) > 0, "The release version must increase");
  manifest.version = version;
  writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

export function planRelease({ event, before, ref, dryRun }) {
  const { version } = clientManifest(readFileSync("package.json", "utf8"));
  const tag = `v${version}`;
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const distTag = versionTag(version);
  let createTag = false;

  git("merge-base", "--is-ancestor", commit, "origin/main");

  if (event === "push") {
    assert.equal(ref, "refs/heads/main");
    assert.match(before, /^[0-9a-f]{40}$/);
    const prior = clientManifest(git("show", `${before}:package.json`));

    if (version === prior.version) return { release: false };

    assert.ok(Bun.semver.order(version, prior.version) > 0, "The release version must increase");
    dryRun = false;
    createTag = true;
  } else {
    assert.equal(event, "workflow_dispatch");

    if (!dryRun || ref !== "refs/heads/main") {
      assert.equal(ref, `refs/tags/${tag}`, `Select ${tag} for this version`);
      assert.equal(
        git("rev-parse", `${ref}^{commit}`),
        commit,
        "The release tag must point to HEAD",
      );
    }
  }

  return { release: true, version, tag, distTag, dryRun, createTag, commit, tree };
}

export function integrity(archive) {
  return `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
}

export async function publishArchive({ archive, expectedIntegrity, version, lookup, publish }) {
  const distTag = versionTag(version);
  assert.equal(integrity(archive), expectedIntegrity, "Release archive differs from qualification");
  const packageUrl = `${registry}/${encodeURIComponent(packageName)}`;
  const response = await lookup(`${packageUrl}/${version}`);

  if (response.status !== 404) {
    assert.ok(response.ok, `npm version lookup failed (${response.status})`);
    const published = await response.json();
    assert.equal(published.name, packageName);
    assert.equal(published.version, version);
    assert.equal(
      published.dist?.integrity,
      expectedIntegrity,
      "That npm version has different published bytes",
    );

    return "already-published";
  }

  if (distTag === "latest") {
    const latest = await lookup(`${packageUrl}/latest`);

    if (latest.status !== 404) {
      assert.ok(latest.ok, `npm latest lookup failed (${latest.status})`);
      const published = await latest.json();
      assert.equal(published.name, packageName);
      versionTag(published.version);
      assert.ok(
        !lowerCoreVersion(version, published.version),
        "That release would move npm latest backwards",
      );
    }
  }

  await publish([
    "publish",
    resolve(archive),
    "--registry",
    registry,
    "--access",
    "public",
    "--tag",
    distTag,
    "--ignore-scripts",
    "--workspaces=false",
  ]);

  return "published";
}

function lowerCoreVersion(candidate, published) {
  const left = candidate.split("-", 1)[0].split(".").map(Number);
  const right = published.split("-", 1)[0].split(".").map(Number);
  const index = left.findIndex((part, index) => part !== right[index]);

  return index !== -1 && left[index] < right[index];
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const env = process.env;

  switch (command) {
    case "version":
      return prepareVersion(argument);
    case "plan": {
      assert.ok(
        env.DRY_RUN === "true" || env.DRY_RUN === "false" || env.GITHUB_EVENT_NAME === "push",
      );
      assert.equal(git("rev-parse", "HEAD"), env.GITHUB_SHA);

      const plan = planRelease({
        event: env.GITHUB_EVENT_NAME,
        before: env.BEFORE_SHA,
        ref: env.GITHUB_REF,
        dryRun: env.DRY_RUN === "true",
      });

      appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries(plan)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );

      return;
    }

    case "integrity":
      console.log(integrity(argument));

      return;
    case "publish": {
      assert.equal(env.GITHUB_ACTIONS, "true");
      assert.equal(env.GITHUB_REPOSITORY, "beachside-compute/credential-broker");
      assert.ok(
        env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        "GitHub OIDC is required",
      );
      assert.equal(git("rev-parse", "HEAD"), env.RELEASE_COMMIT);
      assert.equal(git("rev-parse", "HEAD^{tree}"), env.RELEASE_TREE);
      const { version } = clientManifest(readFileSync("package.json", "utf8"));
      assert.equal(version, env.RELEASE_VERSION);

      const result = await publishArchive({
        archive: argument,
        expectedIntegrity: env.RELEASE_INTEGRITY,
        version,
        lookup: (url) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }),
        publish: (args) =>
          execFileSync("npm", args, { cwd: dirname(resolve(argument)), stdio: "inherit" }),
      });

      console.log(`${packageName}@${version}: ${result}`);

      return;
    }

    default:
      throw new Error("Expected a release command");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
