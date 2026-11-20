import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { integrity, publishArchive, versionTag } from "../scripts/release.mjs";

const releaseScript = resolve(import.meta.dirname, "../scripts/release.mjs");

const packageName = "@beachside/credential-client";

const missing = () => new Response(null, { status: 404 });

function fixture(use) {
  const cwd = mkdtempSync(join(tmpdir(), "credential-client-release-"));

  return Promise.resolve()
    .then(() => use(cwd))
    .finally(() => rmSync(cwd, { recursive: true, force: true }));
}

test("version preparation and release planning require an increase and a matching protected ref", () =>
  fixture((cwd) => {
    const manifest = {
      name: packageName,
      version: "0.1.0",
      private: false,
      publishConfig: { access: "public" },
    };

    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    const output = join(cwd, "plan.env");

    const run = (args, env = {}) =>
      spawnSync(process.execPath, [releaseScript, ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_SHA: git("rev-parse", "HEAD"),
          ...env,
        },
      });

    const plan = (env) => {
      writeFileSync(output, "");
      const result = run(["plan"], env);
      expect(result.status).toBe(0);

      return Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    };

    const push = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" };
    const manual = { GITHUB_EVENT_NAME: "workflow_dispatch", DRY_RUN: "false" };
    git("init", "--initial-branch=main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(cwd, "bun.lock"), "fixture lock unchanged");
    git("add", "package.json", "bun.lock");
    git("commit", "-m", "Start release fixture");
    const before = git("rev-parse", "HEAD");

    // A manifest-only tooling change should not create an npm release.
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ ...manifest, scripts: { check: "fixture" } }),
    );
    git("commit", "-am", "Tooling change without version bump");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(plan({ ...push, BEFORE_SHA: before })).toEqual({ release: "false" });
    expect(run(["version", "0.0.1"]).status).not.toBe(0);
    expect(run(["version", "0.2.0-rc.1"]).status).toBe(0);
    expect(readFileSync(join(cwd, "bun.lock"), "utf8")).toBe("fixture lock unchanged");
    git("commit", "-am", "Version bump");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const commit = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    expect(plan({ ...push, BEFORE_SHA: before })).toEqual({
      release: "true",
      version: "0.2.0-rc.1",
      tag: "v0.2.0-rc.1",
      dryRun: "false",
      createTag: "true",
      distTag: "next",
      commit,
      tree,
    });
    expect(plan({ ...manual, DRY_RUN: "true", GITHUB_REF: "refs/heads/main" }).dryRun).toBe("true");
    expect(run(["plan"], { ...manual, GITHUB_REF: "refs/heads/main" }).status).not.toBe(0);
    expect(run(["plan"], { ...manual, GITHUB_REF: "refs/tags/v0.2.0" }).status).not.toBe(0);
    git("tag", "v0.2.0-rc.1", before);
    const tagged = { ...manual, GITHUB_REF: "refs/tags/v0.2.0-rc.1" };
    expect(run(["plan"], tagged).status).not.toBe(0);
    git("tag", "-f", "v0.2.0-rc.1", commit);
    expect(plan(tagged).createTag).toBe("false");
    expect(run(["version", "0.2.0"]).status).toBe(0);
    git("commit", "-am", "Unmerged draft");
    git("tag", "v0.2.0");
    expect(run(["plan"], { ...manual, GITHUB_REF: "refs/tags/v0.2.0" }).status).not.toBe(0);
  }));

test("archive publication uses the qualified bytes, verifies duplicates, and protects latest", () =>
  fixture(async (cwd) => {
    const archive = join(cwd, "credential-client.tgz");
    writeFileSync(archive, "synthetic archive bytes");
    const expectedIntegrity = integrity(archive);
    const calls = [];

    const prepared = {
      archive,
      expectedIntegrity,
      version: "0.2.0-rc.1",
      lookup: missing,
      publish: (args) => calls.push(args),
    };

    expect(await publishArchive(prepared)).toBe("published");
    expect(calls[0]).toEqual([
      "publish",
      archive,
      "--registry",
      "https://registry.npmjs.org",
      "--access",
      "public",
      "--tag",
      "next",
      "--ignore-scripts",
      "--workspaces=false",
    ]);
    const stable = { ...prepared, version: "0.2.0" };
    expect(await publishArchive(stable)).toBe("published");
    expect(calls.at(-1)).toContain("latest");

    const published = {
      name: packageName,
      version: stable.version,
      dist: { integrity: expectedIntegrity },
    };

    expect(await publishArchive({ ...stable, lookup: () => Response.json(published) })).toBe(
      "already-published",
    );
    await expect(
      publishArchive({
        ...stable,
        lookup: () => Response.json({ ...published, dist: { integrity: "different" } }),
      }),
    ).rejects.toThrow("different published bytes");
    await expect(
      publishArchive({ ...stable, lookup: () => new Response(null, { status: 503 }) }),
    ).rejects.toThrow("lookup failed");
    await expect(
      publishArchive({
        ...stable,
        lookup: (url) =>
          url.endsWith("/latest")
            ? Response.json({ name: packageName, version: "0.10.0" })
            : missing(),
      }),
    ).rejects.toThrow("would move npm latest backwards");
    await expect(
      publishArchive({
        ...stable,
        expectedIntegrity: "wrong",
        lookup: () => {
          throw new Error("unexpected registry lookup");
        },
      }),
    ).rejects.toThrow("differs from qualification");
    expect(calls).toHaveLength(2);
    expect(() => versionTag("1.2.3-01")).toThrow();
    expect(() => versionTag("1.2.3+metadata")).toThrow();
  }));

test("runs the OIDC publish entrypoint in Node and invokes only npm with the tarball", () =>
  fixture((cwd) => {
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    git("init", "--initial-branch=main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "0.2.0",
        private: false,
        publishConfig: { access: "public" },
      }),
    );
    git("add", "package.json");
    git("commit", "-m", "Prepare release");
    const archive = join(cwd, "credential-client.tgz");
    const mockFetch = join(cwd, "fetch.mjs");
    const mockNpm = join(cwd, "npm");
    const args = join(cwd, "npm-args");
    writeFileSync(archive, "qualified fixture archive");
    writeFileSync(
      mockFetch,
      "globalThis.fetch = async () => new Response(null, { status: 404 });\n",
    );
    writeFileSync(mockNpm, '#!/bin/sh\nprintf "%s\\n" "$@" > "$MOCK_NPM_ARGS"\n');
    chmodSync(mockNpm, 0o700);

    const env = {
      ...process.env,
      PATH: `${cwd}:${process.env.PATH}`,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "beachside-compute/credential-broker",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-fixture-token",
      MOCK_NPM_ARGS: args,
      RELEASE_COMMIT: git("rev-parse", "HEAD"),
      RELEASE_TREE: git("rev-parse", "HEAD^{tree}"),
      RELEASE_VERSION: "0.2.0",
      RELEASE_INTEGRITY: integrity(archive),
    };

    const run = (overrides) =>
      spawnSync("node", ["--import", mockFetch, releaseScript, "publish", archive], {
        cwd,
        encoding: "utf8",
        env: { ...env, ...overrides },
      });

    expect(run({ RELEASE_TREE: "incorrect" }).status).not.toBe(0);
    expect(run({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }).status).not.toBe(0);
    expect(() => readFileSync(args)).toThrow();
    const result = run({});
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(args, "utf8").trim().split("\n")).toEqual([
      "publish",
      archive,
      "--registry",
      "https://registry.npmjs.org",
      "--access",
      "public",
      "--tag",
      "latest",
      "--ignore-scripts",
      "--workspaces=false",
    ]);
  }));
