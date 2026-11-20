const encoder = new TextEncoder();

export const grantTokenPattern = /^bsg_[a-f0-9]{64}$/;

export const grantIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));

  return toHex(digest);
}

function toHex(bytes: Uint8Array): string {
  return bytes.reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
}

export function newGrantToken(): string {
  return `bsg_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function bearer(value: string | null): string | undefined {
  return value?.match(/^Bearer ([!-~]+)$/i)?.[1];
}
