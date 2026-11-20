/* oxlint-disable anti-slop/no-runtime-typeof -- Validate broker responses and credentials at the HTTP trust boundary. */

export type Fetch = (request: Request) => Promise<Response>;

export interface BrokerRequestOptions {
  signal?: AbortSignal;
  /** Optional W3C trace context for the trusted broker only. */
  traceParent?: string;
}

export class CredentialBrokerError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARGUMENT"
      | "INVALID_RESPONSE"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "RATE_LIMIT"
      | "TIMEOUT"
      | "WAIT_ABORTED"
      | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "CredentialBrokerError";
  }
}

export const defaultFetch: Fetch = (request) => fetch(request);

export const integrationName = /^[a-z][a-z0-9-]{0,31}$/;

export const sandboxToken = /^bsg_[a-f0-9]{64}$/;

export const bearerToken = /^[A-Za-z0-9._~+/-]{1,16384}={0,2}$/;

export const traceParentPattern = /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-0[01]$/;

const requestTimeout = 10_000;

export function httpsURL(input: string): URL {
  try {
    const url = new URL(input);

    if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return url;
  } catch {
    // The native parse error can echo a URL or included credentials.
  }

  throw new CredentialBrokerError("INVALID_ARGUMENT", "A valid HTTPS URL is required");
}

const apiKey = /^[A-Za-z0-9_-]{32,256}$/;

export function requireApiKey(key: string): void {
  if (typeof key !== "string" || !apiKey.test(key) || sandboxToken.test(key))
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker API key");
}

export function brokerOrigin(input: string): URL {
  const base = httpsURL(input);

  if (base.pathname !== "/" || base.search)
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Use the credential broker HTTPS origin");

  return base;
}

export async function jsonRecord(response: Response) {
  try {
    const data: unknown = await response.json();

    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // A broker or runner response body can contain credentials. Do not attach the parse error.
  }

  throw new CredentialBrokerError("INVALID_RESPONSE", "Credential endpoint returned invalid JSON");
}

export async function fetchRequest(
  transport: Fetch,
  url: URL,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  try {
    return await waitForSignal(init.signal, () =>
      transport(new Request(url, { ...init, redirect: "error" })),
    );
  } catch {
    if (init.signal.aborted)
      throw new CredentialBrokerError("WAIT_ABORTED", "Credential request was cancelled");

    throw new CredentialBrokerError("UNAVAILABLE", "Credential endpoint is unavailable");
  }
}

export function assertStatus(response: Response, expected: number) {
  if (response.status === expected) return;
  void response.body?.cancel().catch(() => undefined);

  switch (response.status) {
    case 401:
      throw new CredentialBrokerError(
        "UNAUTHENTICATED",
        "Credential endpoint rejected authentication",
      );
    case 403:
      throw new CredentialBrokerError("FORBIDDEN", "Credential request was denied");
    case 429:
      throw new CredentialBrokerError(
        "RATE_LIMIT",
        "Credential endpoint is rate limiting requests",
      );
    default:
      throw new CredentialBrokerError(
        "UNAVAILABLE",
        "Credential endpoint could not complete request",
      );
  }
}

export async function waitForSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new CredentialBrokerError("WAIT_ABORTED", "Credential request was cancelled"));

    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) return;

        return work().then(resolve, reject);
      })
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function withRequestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(requestTimeout);

  return { timeout, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}
