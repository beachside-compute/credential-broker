import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the standalone lint configuration loads the vendored anti-slop rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credential-broker-lint-"));

  try {
    const fixture = join(directory, "probe.ts");
    await writeFile(
      fixture,
      "const source = [1, 2];\nexport const result = source.filter((value) => value > 0).map((value) => value * 2);\n",
    );

    const result = Bun.spawnSync(
      [
        join(root, "node_modules/.bin/oxlint"),
        "--config",
        join(root, ".oxlintrc.json"),
        "--format",
        "json",
        fixture,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );

    const diagnostics = result.stdout.toString("utf8");

    expect(result.exitCode).toBe(1);
    expect(diagnostics).toContain("anti-slop(no-array-filter-map)");
    expect(diagnostics).toContain("anti-slop(require-readable-spacing)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
