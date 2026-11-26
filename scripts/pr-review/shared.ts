import { freestyle } from "@beachside/freestyle";
import { Beachside, BeachsideError, NonzeroExitError } from "beachside";
import type { BeachsideClient, ExecInput, ExecOutput, SandboxHandle } from "beachside";

/** Every sandbox this example creates carries this label, so the sweep can find leftovers. */
export const LABEL = "credential-broker.pr-review";

/** Freestyle's smallest Ubuntu 24.04 base: 2 vCPU, 4 GiB. */
export const BASE_IMAGE = "freestyle/ubuntu-sm";

/** Freestyle runs commands as `ubuntu`; the tools live in its home so no step needs root at run time. */
export const HOME = "/home/ubuntu";

export const TOOLS = `${HOME}/.pr-review`;

export const PI = `${TOOLS}/node/bin/pi`;

export const PATH = `${TOOLS}/node/bin:/usr/local/bin:/usr/bin:/bin`;

export const NODE_VERSION = "24.22.3";

export const PI_VERSION = "1.6.0";

const NODE_SHA256 = {
  x64: "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb",
  arm64: "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c",
};

/** Written last by the install, so a snapshot without it (or with older versions) is reinstalled. */
export const READY = `${TOOLS}/ready-node${NODE_VERSION}-pi${PI_VERSION}`;

/**
 * Install steps, each a POSIX `sh` script short enough for Freestyle's five-minute exec limit on
 * older guest agents. Git and GitHub CLI come from apt (GitHub's signed repository for `gh`),
 * Node from its checksummed release tarball, and Pi from npm at a pinned version.
 */
export const INSTALL_STEPS: readonly { name: string; script: string }[] = [
  {
    name: "git and GitHub CLI",
    script: [
      "set -eu",
      "export DEBIAN_FRONTEND=noninteractive",
      "sudo -n apt-get update -qq",
      "sudo -n apt-get install -y -qq ca-certificates curl git xz-utils >/dev/null",
      "sudo -n mkdir -p -m 755 /etc/apt/keyrings",
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo -n tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null",
      "sudo -n chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo -n tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
      "sudo -n apt-get update -qq",
      "sudo -n apt-get install -y -qq gh >/dev/null",
      "git --version && gh --version | head -1",
    ].join("\n"),
  },
  {
    name: `Node ${NODE_VERSION}`,
    script: [
      "set -eu",
      'case "$(uname -m)" in',
      `  x86_64) arch=x64; sum=${NODE_SHA256.x64} ;;`,
      `  aarch64) arch=arm64; sum=${NODE_SHA256.arm64} ;;`,
      '  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;',
      "esac",
      `name=node-v${NODE_VERSION}-linux-$arch`,
      `rm -rf ${TOOLS}/node && mkdir -p ${TOOLS}`,
      `curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$name.tar.xz" -o /tmp/node.tar.xz`,
      'echo "$sum  /tmp/node.tar.xz" | sha256sum -c - >/dev/null',
      `tar -xJf /tmp/node.tar.xz -C ${TOOLS} && mv "${TOOLS}/$name" ${TOOLS}/node && rm /tmp/node.tar.xz`,
      `${TOOLS}/node/bin/node --version`,
    ].join("\n"),
  },
  {
    name: `Pi ${PI_VERSION}`,
    script: [
      "set -eu",
      `${TOOLS}/node/bin/npm install --global --prefix ${TOOLS}/node --ignore-scripts --no-fund --no-audit @earendil-works/pi-coding-agent@${PI_VERSION} >/dev/null`,
      `${PI} --version`,
      `touch ${READY}`,
    ].join("\n"),
  },
];

/** The smallest surface of a sandbox handle these scripts use, so tests can pass a fake. */
export type Box = Pick<SandboxHandle, "exec">;

/** Run a command and return its result whatever the exit code; `exec` throws on a nonzero one. */
export async function run(box: Box, input: ExecInput, signal: AbortSignal): Promise<ExecOutput> {
  try {
    return await box.exec(input, { signal });
  } catch (error) {
    if (error instanceof NonzeroExitError) return error.result;

    throw error;
  }
}

/** Blank out anything shaped like a broker grant, GitHub token or model key before it is logged. */
export function redact(text: string) {
  return text.replace(
    /\b(bsg_|github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}/g,
    (_, prefix: string) => `${prefix}[redacted]`,
  );
}

export function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name]?.trim();

  if (!value) throw new Error(`Set ${name}.`);

  return value;
}

/** Run one shell script and fail with its last stderr line, never with its environment. */
export async function sh(
  box: Box,
  script: string,
  stage: string,
  signal: AbortSignal,
  options: { cwd?: string; env?: Record<string, string>; deadlineSeconds?: number } = {},
) {
  const result = await run(
    box,
    {
      command: { kind: "argv", argv: ["/bin/sh", "-c", script] },
      cwd: options.cwd ?? HOME,
      env: { PATH, ...options.env },
      deadlineSeconds: options.deadlineSeconds ?? 280,
      maxOutputBytes: 65_536,
    },
    signal,
  );

  if (result.exitCode !== 0) {
    const reason = redact(
      result.stderrText({ full: true }).trim().split("\n").at(-1)?.slice(0, 300) ?? "",
    );

    throw new Error(`${stage} failed (exit ${result.exitCode}).${reason ? ` ${reason}` : ""}`);
  }

  return result;
}

/** Install the tools unless the image already has this exact set. */
export async function ensureTools(box: Box, signal: AbortSignal) {
  const ready = await run(
    box,
    { command: { kind: "argv", argv: ["test", "-f", READY] }, cwd: HOME, deadlineSeconds: 30 },
    signal,
  );

  if (ready.exitCode === 0) return false;

  for (const step of INSTALL_STEPS) {
    console.log(`Installing ${step.name}.`);
    await sh(box, step.script, `Installing ${step.name}`, signal);
  }

  return true;
}

export type FreestyleSetup = {
  apiKey: string;
  /** A `sh-…` snapshot from the image job; omitted boots the plain Ubuntu base. */
  image?: string;
  lifetimeSeconds: number;
  /** Seconds Freestyle keeps each captured snapshot. */
  retentionSeconds?: number;
};

export function connect(setup: FreestyleSetup, signal: AbortSignal): Promise<BeachsideClient> {
  return Beachside.connect(
    freestyle({
      apiKey: setup.apiKey,
      image: setup.image ?? BASE_IMAGE,
      network: "internet",
      lifecycle: { lifetimeSeconds: setup.lifetimeSeconds },
      ...(setup.retentionSeconds !== undefined && {
        snapshots: { retentionSeconds: setup.retentionSeconds },
      }),
    }),
    { signal },
  );
}

/**
 * Connect on the prepared snapshot, or on the plain base when there is none or Freestyle no
 * longer has it (it expired or was deleted). The tools are then installed at run time instead.
 */
export async function connectPrepared(setup: FreestyleSetup, signal: AbortSignal) {
  if (setup.image) {
    try {
      return await connect(setup, signal);
    } catch (error) {
      if (!(error instanceof BeachsideError) || error.code !== "NOT_FOUND") throw error;

      console.log(`Snapshot ${setup.image} is gone; starting from ${BASE_IMAGE}.`);
    }
  }

  return connect({ ...setup, image: undefined }, signal);
}

/** Reads the snapshot id the image job saved, if the cache restored one. */
export async function savedImage(path: string | undefined) {
  if (!path) return undefined;

  const file = Bun.file(path);

  if (!(await file.exists())) return undefined;

  const id = (await file.text()).trim();

  return /^sh-[A-Za-z0-9_.-]+$/.test(id) ? id : undefined;
}
