import type { BeachsideClient, SandboxListEntry } from "beachside";
import { BeachsideError } from "beachside";
import { connect, LABEL, required } from "./shared";

/** Anything labelled by this example and older than this is a leftover. Reviews end well before. */
export const MAX_AGE_SECONDS = 3_600;

type Listed = Pick<SandboxListEntry, "state" | "labels" | "createdAt"> & { reference: unknown };

export function leftovers<T extends Listed>(items: readonly T[], now: number) {
  return items.filter(
    (item) =>
      item.state !== "destroyed" &&
      item.labels?.[LABEL] !== undefined &&
      item.createdAt !== null &&
      now - Date.parse(item.createdAt) > MAX_AGE_SECONDS * 1000 &&
      item.reference !== null,
  );
}

export async function sweep(client: BeachsideClient, signal: AbortSignal, now = Date.now()) {
  const items: SandboxListEntry[] = [];
  let cursor: string | undefined;

  do {
    if (signal.aborted) throw signal.reason;
    const page = await client.sandboxes.list({ cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  let failed = 0;

  for (const item of leftovers(items, now)) {
    try {
      const box = await client.sandboxes.get(item.reference!, { signal });
      await box.destroy({ signal });
      console.log(`Destroyed leftover sandbox ${item.id} (${item.labels![LABEL]}).`);
    } catch (error) {
      if (error instanceof BeachsideError && error.code === "NOT_FOUND") continue;

      failed++;
      console.error(
        `Could not destroy ${item.id}: ${error instanceof BeachsideError ? error.code : "error"}.`,
      );
    }
  }

  return failed;
}

async function main() {
  const signal = AbortSignal.timeout(300_000);

  const client = await connect(
    { apiKey: required(process.env, "FREESTYLE_API_KEY"), lifetimeSeconds: 900 },
    signal,
  );

  try {
    if ((await sweep(client, signal)) > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Sweep failed.");
    process.exitCode = 1;
  }
}
