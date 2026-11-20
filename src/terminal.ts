import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CredentialBrokerError } from "./transport.js";

export type Ask = (label: string, secret?: boolean) => Promise<string>;

export async function terminalPrompt<T>(
  nonInteractive: string,
  cancelled: string,
  run: (ask: Ask, write: (message: string) => void) => Promise<T>,
): Promise<T> {
  const { stdin, stderr } = process;

  if (!stdin.isTTY || !stderr.isTTY)
    throw new CredentialBrokerError("INVALID_ARGUMENT", nonInteractive);
  let masked = false;

  const output = new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      if (masked) callback();
      else stderr.write(chunk, callback);
    },
  });

  const prompt = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  const signal = new AbortController();
  prompt.on("SIGINT", () => signal.abort());
  prompt.on("close", () => signal.abort());

  const ask: Ask = async (label, secret = false) => {
    stderr.write(label);
    masked = secret;

    try {
      return await prompt.question("", { signal: signal.signal });
    } catch {
      throw new CredentialBrokerError("INVALID_ARGUMENT", cancelled);
    } finally {
      masked = false;

      if (secret) stderr.write("\n");
    }
  };

  try {
    return await run(ask, (message) => {
      stderr.write(message);
    });
  } finally {
    prompt.close();
    stdin.pause();
  }
}
