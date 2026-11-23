#!/usr/bin/env node
import { isCancel, password } from "@clack/prompts";
import { runBrokerCli } from "./commands.js";

async function promptKey(role: "admin" | "issuer"): Promise<string | undefined> {
  const { stdin: input, stderr: output } = process;

  if (!input.isTTY || !output.isTTY) return;

  try {
    const value = await password({
      input,
      output,
      message: `Broker ${role} key (used once, not saved)`,
    });

    return isCancel(value) ? undefined : value;
  } finally {
    input.pause();
  }
}

process.exitCode = await runBrokerCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
  // The checkout runner (`bun run broker`) names itself in hints.
  prefix: process.env.BEACHSIDE_BROKER_CLI_PREFIX || undefined,
  promptKey,
});
