import { connect, ensureTools, LABEL, READY, required } from "./shared";

/** Freestyle deletes each image this long after capture; the weekly job replaces it first. */
export const RETENTION_SECONDS = 14 * 24 * 3_600;

/**
 * Boot the plain Ubuntu base, install the reviewer's tools, capture a Freestyle snapshot and
 * write its `sh-…` id to `REVIEW_IMAGE_FILE`. The source VM is destroyed either way; the
 * snapshot is left for Freestyle to expire.
 */
async function main() {
  const out = required(process.env, "REVIEW_IMAGE_FILE");
  const signal = AbortSignal.timeout(1_200_000);

  const client = await connect(
    {
      apiKey: required(process.env, "FREESTYLE_API_KEY"),
      lifetimeSeconds: 1_800,
      retentionSeconds: RETENTION_SECONDS,
    },
    signal,
  );

  try {
    const id = await client.sandboxes.with(
      { labels: { [LABEL]: `image-${process.env.GITHUB_RUN_ID?.trim() || Date.now()}` } },
      async (box) => {
        console.log(`Created Freestyle sandbox ${box.id}.`);
        await ensureTools(box, signal);
        console.log(`Tools ready (${READY}). Capturing a snapshot.`);
        const captured = await box.snapshot(undefined, { signal });

        return captured.snapshot.reference.nativeId;
      },
      { signal, cleanupTimeoutMs: 60_000 },
    );

    await Bun.write(out, `${id}\n`);
    console.log(`Saved review image ${id}; Freestyle keeps it for 14 days.`);
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Building the review image failed.");
    process.exitCode = 1;
  }
}
