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
  /**
   * Awaited ONCE before each InvokeModel request. Titan V2's on-demand cap is
   * 60 requests/min and is NOT adjustable, so a burst of sequential embeds
   * trips it (429) and the ingest refuses. Wire `makeRpmPacer(...)` here to
   * throttle to a safe rate; omit it (or pass a rate <= 0) to leave requests
   * unpaced — for provisioned-throughput deployments, or the read path where a
   * single query embed is nowhere near the cap.
   */
  readonly pace?: () => Promise<void>;
}

/**
 * The process-wide ingest pacer, shared by EVERY Bedrock vendor and call,
 * because the per-minute InvokeModel cap is a property of the ACCOUNT, not of a
 * model. Read once from `KSOR_BEDROCK_MAX_RPM` (default 50 — a safety margin
 * under Titan V2's non-adjustable 60/min); set it to 0 to disable pacing for a
 * provisioned-throughput deployment. Wire the returned hook into
 * `BedrockTransportOptions.pace`.
 */
let sharedIngestPacer: (() => Promise<void>) | undefined;
export function ingestPacer(): () => Promise<void> {
  if (sharedIngestPacer === undefined) {
    const rpm = Number.parseInt(process.env["KSOR_BEDROCK_MAX_RPM"] ?? "50", 10);
    sharedIngestPacer = makeRpmPacer(Number.isFinite(rpm) ? rpm : 50);
  }
  return sharedIngestPacer;
}
/**
 * A token-bucket pacer gating to at most `rpm` calls per minute. The bucket
 * starts full (capacity `rpm`) so a small ingest never waits; a sustained
 * ingest settles to one call per `60000/rpm` ms. `rpm <= 0` disables pacing
 * (returns a no-op). Clock and sleep are injectable for deterministic tests.
 */
export function makeRpmPacer(
  rpm: number,
  deps?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
): () => Promise<void> {
  if (rpm <= 0) return async (): Promise<void> => {};
  const now = deps?.now ?? ((): number => Date.now());
  const sleep =
    deps?.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const refillMs = 60_000 / rpm; // ms per token
  const capacity = rpm;
  let tokens = capacity;
  let last = now();
  return async (): Promise<void> => {
    for (;;) {
      const t = now();
      tokens = Math.min(capacity, tokens + (t - last) / refillMs);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - tokens) * refillMs));
    }
  };
}

const SERVICE = "bedrock";

/**
 * RFC 3986 / AWS SigV4 encoding of ONE path segment. `encodeURIComponent`
 * leaves `!*'()` unescaped, which AWS requires escaped, so those are fixed up;
 * the unreserved set `A-Za-z0-9-._~` is left alone. Applied to a single
 * segment only — it never sees a `/`, so separators are preserved by the
 * caller joining segments with `/`.
 */
function awsUriEncodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

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
  // Pace BEFORE the timestamp is fixed: this is the request that counts against
  // the account's per-minute InvokeModel cap (Titan V2 = 60/min, not
  // adjustable). Waiting here — not after signing — keeps `amzDate` equal to
  // when the request actually goes out, so a paced wait never drifts the
  // signature toward Bedrock's clock-skew tolerance.
  if (opts.pace !== undefined) await opts.pace();
  const now = (opts.clock ?? ((): Date => new Date()))();
  const creds = await opts.credentials();

  // The path has ONE variable segment — the model id — which may contain
  // reserved chars (`amazon.titan-embed-text-v2:0` has a `:`). Two forms are
  // needed and they are NOT the same:
  //   * wireUri: each segment encoded ONCE (`:` -> `%3A`). This is what goes on
  //     the wire; Bedrock routes on it.
  //   * canonicalUri: the SigV4 canonical URI, each segment encoded AGAIN
  //     (`%3A` -> `%253A`), per the AWS rule for every service except S3. This
  //     is what the string-to-sign is computed over. Signing the wire form
  //     makes Bedrock reject Titan with 403 SignatureDoesNotMatch, because it
  //     canonicalizes the double-encoded form.
  // Path separators are preserved: `/model` and `/invoke` are fixed literals
  // and only the model segment is encoded — the whole path is never blindly run
  // through the encoder.
  const modelWire = awsUriEncodeSegment(params.model);
  const modelCanonical = awsUriEncodeSegment(modelWire);
  const wireUri = `/model/${modelWire}/invoke`;
  const canonicalUri = `/model/${modelCanonical}/invoke`;
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

  const res = await doFetch(`https://${host}${wireUri}`, {
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

/**
 * A failure to RESOLVE AWS credentials at call time — no credentials in the
 * environment, or an AgentCore/ECS workload-role endpoint that refused. It is
 * an ACCOUNT/ENVIRONMENT failure, not a property of any passage, so the ingest
 * drain must abort on it (see `isFatal`) rather than quarantine chunks for a
 * reason that has nothing to do with them.
 */
export class BedrockCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BedrockCredentialsError";
  }
}

/**
 * The ACCOUNT-level classification (`EmbeddingProvider.isFatal`): true when no
 * amount of waiting and no other passage changes the outcome, so the ingest
 * drain aborts with the queue left PENDING instead of quarantining chunk after
 * chunk. For Bedrock that is:
 *
 *   - a credential-resolution failure (`BedrockCredentialsError`) — no creds,
 *     or a workload-role endpoint that refused; and
 *   - HTTP 401 / 403 — an expired or invalid signature, `AccessDeniedException`,
 *     or the account/role lacking `bedrock:InvokeModel` on the model. Retrying
 *     these burns quota and, worse, marking every chunk `failed` would record an
 *     auth problem as a corpus of poisoned passages. The operator fixes the
 *     credential or the model grant and re-runs; resume embeds what this run did
 *     not.
 */
export function isFatal(exc: unknown): boolean {
  if (exc instanceof BedrockCredentialsError) return true;
  return exc instanceof BedrockHttpError && (exc.status === 401 || exc.status === 403);
}
