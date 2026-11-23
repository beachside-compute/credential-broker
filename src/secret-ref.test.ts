import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSecret } from "./secret-ref";

/** Stand-in password manager CLIs that print their arguments' secret and record their environment. */
function managers() {
  const bin = mkdtempSync(join(tmpdir(), "secret-ref-"));

  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nenv > "${bin}/${name}.env"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };

  tool(
    "op",
    'case "$3" in op://v/item/key) printf %s op-secret ;; *) echo "item $3 secret-hint" >&2; exit 3 ;; esac',
  );
  tool("bws", 'printf \'{"value":"bws-secret"}\'');
  tool("pass", 'printf "pass-secret\\nnotes\\n"');

  return {
    bin,
    env: { PATH: `${bin}:/usr/bin:/bin`, BEACHSIDE_BROKER_ISSUER_KEY: "other-role-key" },
  };
}

test("resolves each reference form through its manager's CLI", async () => {
  const { bin, env } = managers();

  try {
    expect(await resolveSecret("plain-key", "KEY", env)).toBe("plain-key");
    expect(await resolveSecret("op://v/item/key", "KEY", env)).toBe("op-secret");
    expect(
      await resolveSecret(`bws://${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}`, "KEY", env),
    ).toBe("bws-secret");
    expect(await resolveSecret("pass://team/broker", "KEY", env)).toBe("pass-secret");
    // An env: reference yields the variable as it is, never a second lookup.
    expect(await resolveSecret("env:NESTED", "KEY", { ...env, NESTED: "op://v/item/key" })).toBe(
      "op://v/item/key",
    );
    // A manager never sees the other broker keys in the environment.
    expect(await Bun.file(join(bin, "op.env")).text()).not.toContain("other-role-key");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("reports a failed lookup without the manager's output", async () => {
  const { bin, env } = managers();

  try {
    const failure = resolveSecret("op://v/item/missing", "KEY", env);
    await expect(failure).rejects.toThrow("op exited with 3");
    await expect(failure).rejects.not.toThrow("secret-hint");
    await expect(resolveSecret("op://v/item/key", "KEY", { PATH: "/nonexistent" })).rejects.toThrow(
      "`op` is not installed",
    );
    await expect(resolveSecret("env:UNSET", "KEY", env)).rejects.toThrow("which is not set");

    for (const reference of [
      "pass://../secret",
      "pass://team/../secret",
      "pass://./secret",
      "op://v",
    ])
      await expect(resolveSecret(reference, "KEY", env)).rejects.toThrow("not a valid");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
