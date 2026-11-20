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
    /** Why the broker refused grant issuance, when it said so. */
    readonly reason?: IssuanceRefusal,
    /** The integrations the refusal names. */
    readonly integrations?: readonly string[],
  ) {
    super(message);
    this.name = "CredentialBrokerError";
  }
}

/** Why a broker refused to issue a grant for some integrations. */
export type IssuanceRefusal = "not_in_policy" | "not_found" | "disabled" | "not_allowlisted";

const refusals: readonly IssuanceRefusal[] = [
  "not_in_policy",
  "not_found",
  "disabled",
  "not_allowlisted",
];

/** The command-line prefix used in hints. Embedding CLIs replace it, for example with `beachside broker`. */
let hintPrefix = "beachside-broker";

export function setHintPrefix(prefix: string): void {
  hintPrefix = prefix;
}

export function hint(command: string): string {
  return `${hintPrefix} ${command}`;
}

export function refusalMessage(reason: IssuanceRefusal, ids: readonly string[]): string {
  const names = ids.join(", ");
  const plural = ids.length > 1;

  switch (reason) {
    case "not_found":
      return `No integration${plural ? "s" : ""} named ${names} ${plural ? "exist" : "exists"} on this broker. List them with \`${hint("integration list")}\``;
    case "disabled":
      return plural
        ? `Integrations ${names} are disabled. Enable each with ${ids.map((id) => `\`${hint(`integration enable ${id}`)}\``).join(", ")}`
        : `Integration ${names} is disabled. Enable it with \`${hint(`integration enable ${names}`)}\``;
    case "not_allowlisted":
      return `Integration${plural ? "s" : ""} ${names} ${plural ? "are" : "is"} not allowed to issue grants. Allow ${plural ? "them" : "it"} with \`${hint(`issuer allow ${ids.join(" ")}`)}\``;
    case "not_in_policy":
      return `This GitHub Actions workflow's broker policy does not include ${names}. Add ${plural ? "them" : "it"} to the workflow's integrations in BROKER_CONFIG and redeploy`;
  }
}

/** Read a broker error body: only known codes, reasons and integration names cross. */
export async function brokerFailure(response: Response): Promise<{
  error?: string;
  reason?: IssuanceRefusal;
  integrations?: string[];
}> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    void response.body?.cancel().catch(() => undefined);

    return {};
  }

  try {
    const text = await response.text();

    if (text.length > 4_096) return {};

    const body: unknown = JSON.parse(text);

    if (!body || typeof body !== "object") return {};

    const error =
      "error" in body && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error)
        ? body.error
        : undefined;

    const reason = "reason" in body ? refusals.find((value) => value === body.reason) : undefined;

    const integrations =
      "integrations" in body &&
      Array.isArray(body.integrations) &&
      body.integrations.length <= 16 &&
      body.integrations.every((id) => typeof id === "string" && integrationName.test(id))
        ? body.integrations.map(String)
        : undefined;

    return { error, reason, integrations };
  } catch {
    // Never echo a malformed body.
    return {};
  }
}

export const defaultFetch: Fetch = (request) => fetch(request);

export const integrationName = /^[a-z][a-z0-9-]{0,31}$/;

/** Seven days. The broker refuses longer grants. */
export const maxGrantTtlSeconds = 604_800;

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

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** HTTPS, or plain HTTP to a loopback host for a local `wrangler dev` broker. */
function brokerURL(input: string): URL {
  try {
    const url = new URL(input);

    if (
      url.protocol === "http:" &&
      loopback.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    )
      return url;
  } catch {
    // Fall through to the HTTPS parser and its sanitized error.
  }

  return httpsURL(input);
}

export function brokerOrigin(input: string): URL {
  const base = brokerURL(input);

  if (base.pathname !== "/" || base.search)
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      "Use the credential broker origin: HTTPS, or HTTP to localhost, 127.0.0.1 or [::1]",
    );

  return base;
}

export function gatewayBaseURL(base: URL, integration: string): string {
  return `${base.origin}/gateway/${integration}`;
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

/**
 * Send one request. A transport failure is retryable (`UNAVAILABLE`), except for a write that is
 * not safe to repeat: the broker may have applied it, so its outcome is unknown (`TIMEOUT`).
 */
export async function fetchRequest(
  transport: Fetch,
  url: URL,
  init: RequestInit & { signal: AbortSignal },
  unsafeWrite = false,
): Promise<Response> {
  try {
    return await waitForSignal(init.signal, () =>
      transport(new Request(url, { ...init, redirect: "error" })),
    );
  } catch {
    if (init.signal.aborted)
      throw new CredentialBrokerError("WAIT_ABORTED", "Credential request was cancelled");

    if (unsafeWrite)
      throw new CredentialBrokerError(
        "TIMEOUT",
        "The connection to the credential endpoint failed, so the request may have been applied. Check before retrying",
      );

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
