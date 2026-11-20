import { grantTokenPattern } from "../grants/tokens";

const encoder = new TextEncoder();

const apiKeyPattern = /^[A-Za-z0-9_-]{32,256}$/;

export function isBrokerApiKey(value: string | undefined): value is string {
  return value !== undefined && apiKeyPattern.test(value) && !grantTokenPattern.test(value);
}

export async function matchesKey(
  expected: string | undefined,
  presented: string,
): Promise<boolean> {
  if (!isBrokerApiKey(expected) || !isBrokerApiKey(presented)) return false;

  const [stored, candidate] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
  ]);

  return crypto.subtle.timingSafeEqual(stored, candidate);
}
