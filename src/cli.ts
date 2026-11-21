#!/usr/bin/env node
import { runBrokerCli } from "./commands.js";

process.exitCode = await runBrokerCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
  // The checkout runner (`bun run broker`) names itself in hints.
  prefix: process.env.BEACHSIDE_BROKER_CLI_PREFIX || undefined,
});
