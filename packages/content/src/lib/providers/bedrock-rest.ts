/**
 * The MODEL-NEUTRAL Amazon Bedrock transport: hand-rolled SigV4 over `fetch`
 * for a single `InvokeModel` POST, plus the credential types, the HTTP error
 * the retry classifier reads, and the plane-aware retry classifier itself.
 *
 * Extracted from `bedrock-cohere-rest.ts` (#Titan) so a second Bedrock vendor —
 * Titan — signs the SAME way without copying the signer. The split is exactly
 * the one decision 13 draws for the MCP door: the TRANSPORT is shared, the
 * vendor PAYLOAD SERIALIZATION is not. This file knows how to sign and send an
 * opaque JSON body to `InvokeModel` and how to classify a failure; it knows
 * nothing about `input_type`, `inputText`, `dimensions`, or how a vendor shapes
 * its embedding response. Each vendor's `*-rest.ts` builds the request body and
 * unwraps the response around `bedrockInvokeModel`.
 *
 * WHY NOT THE AWS SDK: the same reason Gemini (#54) and Cohere took — one HTTP
 * call needs only `node:crypto`, and `@aws-sdk/client-bedrock-runtime` would put
 * megabytes into every `ksor init` that embeds nothing (decision 12). AUTH is
 * SigV4 from the ambient AWS credential chain, not a bearer key, so a provider
 * built on this transport is keyless (`needsApiKey: false`, `keyEnv: null`).
 */

import { createHash, createHmac } from "node:crypto";

/** An HTTP-shaped failure carrying the status the retry classifier reads. */
export class BedrockHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Bedrock API error ${status}: ${detail}`);
    this.name = "BedrockHttpError";
    this.status = status;
  }
}

/** Resolved AWS credentials for one signing operation. A session token is
 * present for STS/SSO temporary credentials and absent for long-lived keys. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** Resolves credentials at call time (they rotate under SSO/instance roles). */
export type CredentialProvider = () => Promise<AwsCredentials>;

export interface BedrockTransportOptions {
  readonly region: string;
  readonly credentials: CredentialProvider;
  /** Injected in tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the public Bedrock runtime host. */
  readonly hostOverride?: string;
  /**
   * Injected in tests; defaults to `() => new Date()`. Pinning the clock makes
   * the signature deterministic — the whole point of SigV4 is that the same
   * body, credentials and instant produce the same `Authorization` header, so
   * a test can assert the exact string rather than only its shape.
   */
  readonly clock?: () => Date;
}

const SERVICE = "bedrock";

const sha256hex = (data: string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Sign and send ONE `InvokeModel` POST. `body` is the vendor's already-built
 * JSON string; the return is the parsed JSON response (the caller casts it to
 * its own vendor shape). A non-2xx throws `BedrockHttpError` carrying the
 * vendor message so the retry classifier and the operator both get the status.
 *
 * The canonical request is byte-for-byte what the Cohere transport signed
 * before extraction — headers lowercased and sorted, the security-token header
 * signed only when a session token exists — so no signed request changed shape.
 */
export async function bedrockInvokeModel(
  opts: BedrockTransportOptions,
  params: { readonly model: string; readonly body: string; readonly timeoutMs: number },
): Promise<unknown> {
  const host = opts.hostOverride ?? `bedrock-runtime.${opts.region}.amazonaws.com`;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = (opts.clock ?? ((): Date => new Date()))();
  const creds = await opts.credentials();

  const canonicalUri = `/model/${encodeURIComponent(params.model)}/invoke`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(params.body);

  // Header set is sorted and lowercased; the security-token header is only
  // signed when a session token exists (long-lived keys have none).
  const headerPairs: Array<[string, string]> = [
    ["content-type", "application/json"],
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  if (creds.sessionToken !== undefined && creds.sessionToken !== "") {
    headerPairs.push(["x-amz-security-token", creds.sessionToken]);
  }
  headerPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerPairs.map(([k]) => k).join(";");

  const canonicalRequest = `POST\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${opts.region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signature = hmac(
    signingKey(creds.secretAccessKey, dateStamp, opts.region, SERVICE),
    stringToSign,
  ).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    authorization,
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (creds.sessionToken !== undefined && creds.sessionToken !== "") {
    headers["x-amz-security-token"] = creds.sessionToken;
  }

  const res = await doFetch(`https://${host}${canonicalUri}`, {
    method: "POST",
    headers,
    body: params.body,
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const msg = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof msg === "string") detail = msg;
    } catch {
      /* not JSON — truncated body is the best detail */
    }
    throw new BedrockHttpError(res.status, detail);
  }
  return JSON.parse(text);
}

/** True for a transport blip with no HTTP status of its own. */
function isTransportBlip(exc: unknown): boolean {
  if (exc instanceof BedrockHttpError) return false;
  const name = (exc as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError" || name === "TypeError";
}

function httpStatusOf(exc: unknown): number | undefined {
  return exc instanceof BedrockHttpError ? exc.status : undefined;
}

/**
 * The INGEST plane's taxonomy: transport blips, 5xx, AND 429
 * (ThrottlingException) — batch work is resumable and has nobody waiting.
 * Shared by every Bedrock vendor because the two planes are a property of
 * ksor, not of a vendor.
 */
export function isRetryable(exc: unknown): boolean {
  if (isTransportBlip(exc)) return true;
  const status = httpStatusOf(exc);
  if (status === undefined) return false;
  return (status >= 500 && status <= 599) || status === 429;
}

/**
 * The READ plane's: transport blips + 5xx only, NEVER 429. A throttled
 * account stays throttled on the next second, so a search degrades to
 * keyword-only now rather than stalling a reader behind backoff.
 */
export function isRetryableQuery(exc: unknown): boolean {
  if (isTransportBlip(exc)) return true;
  const status = httpStatusOf(exc);
  return status !== undefined && status >= 500 && status <= 599;
}
