/**
 * Amazon Bedrock's Cohere Embed endpoint, over `fetch` with hand-rolled SigV4
 * — no SDK.
 *
 * The same decision the Gemini (#54) and OpenAI transports made, for the same
 * reason: this is ONE HTTP call (`InvokeModel`) behind a structurally-typed
 * slice, and `@aws-sdk/client-bedrock-runtime` would put megabytes and a large
 * transitive tree into every `ksor init` that never embeds anything (decision
 * 12's dependency-weight discipline). SigV4 for a single POST needs only
 * `node:crypto`, which the fake provider already uses. If a provider ever
 * genuinely needs an SDK the seam takes one through `clientFactory`; nothing
 * here forecloses that.
 *
 * WHAT DIFFERS FROM THE OTHER VENDORS, worth knowing before choosing:
 *
 *   AUTH is SigV4 from the ambient AWS credential chain, NOT a bearer key. The
 *   registry row is therefore keyless (`needsApiKey: false`, `keyEnv: null`) —
 *   the case the seam anticipates for "an IAM-authenticated transport". A
 *   `CredentialProvider` is injected so the runtime resolves credentials from
 *   the environment / SSO / instance role exactly as any AWS tool does, and
 *   tests inject a fixed credential.
 *
 *   Cohere v3 embeds ASYMMETRICALLY, like Gemini and unlike OpenAI: the vendor
 *   `input_type` (`search_document` vs `search_query`) produces different
 *   vectors for the same text (measured cosine ~0.69 same-text), and the
 *   plane's intent picks which. Both labels are therefore non-empty and the
 *   seam's "a provider whose two vendor labels are equal can never mis-route a
 *   plane" does NOT apply — mis-routing here is a real correctness risk, so the
 *   intent must reach this transport.
 *
 *   Cohere returns RAW vectors that happen to arrive ~L2-normalized already;
 *   the framework re-normalizes regardless (embedding.ts contract), so this
 *   transport returns them untouched like every other adapter.
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

export interface BedrockCohereRestOptions {
  readonly region: string;
  readonly credentials: CredentialProvider;
  /** Injected in tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the public Bedrock runtime host. */
  readonly hostOverride?: string;
}

/** The slice the provider consumes — the same shape the other clients present. */
export interface BedrockCohereEmbedClient {
  embed(params: {
    model: string;
    input: readonly string[];
    inputType: string;
    timeoutMs: number;
  }): Promise<{ embeddings: ReadonlyArray<{ values?: number[] }> }>;
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

export function bedrockCohereRestEmbedClient(
  opts: BedrockCohereRestOptions,
): BedrockCohereEmbedClient {
  const host = opts.hostOverride ?? `bedrock-runtime.${opts.region}.amazonaws.com`;
  return {
    async embed(params) {
      const doFetch = opts.fetchImpl ?? fetch;
      const creds = await opts.credentials();
      // NO embedding_types → the default `embeddings_floats` shape, a bare
      // `embeddings: [[...]]` array. Asking for a type keys the response by it
      // (`embeddings.float`), an unnecessary shape to unwrap.
      //
      // CLIENT-SIDE TRUNCATION to 2048 characters is REQUIRED. Cohere v3 on
      // Bedrock enforces a hard 2048-CHARACTER maxLength per text as INPUT
      // SCHEMA validation and rejects anything longer with a 400
      // (`expected maxLength: 2048, actual: N`) — verified live, and crucially
      // the vendor's own `truncate: "END"` does NOT bypass it (the schema check
      // runs before truncation). That limit is far tighter than Gemini's ~8000
      // (2048 TOKEN) window, so a chunk the framework produced under its own
      // HARD_MAX_CHARS=4000 would fail. We cut the tail — the least topical part
      // of a heading-led chunk — so the vendor stays usable on the shipped chunk
      // sizes. `truncate: "END"` is kept as belt-and-suspenders for the separate
      // TOKEN limit on inputs that are under 2048 chars but over 512 tokens.
      const COHERE_V3_MAX_CHARS = 2048;
      const texts = params.input.map((t) =>
        t.length > COHERE_V3_MAX_CHARS ? t.slice(0, COHERE_V3_MAX_CHARS) : t,
      );
      const body = JSON.stringify({
        texts,
        input_type: params.inputType,
        truncate: "END",
      });

      const canonicalUri = `/model/${encodeURIComponent(params.model)}/invoke`;
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
      const dateStamp = amzDate.slice(0, 8);
      const payloadHash = sha256hex(body);

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
        body,
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
      // Bare `embeddings_floats`: { embeddings: [[...1024...]], texts, id, response_type }.
      // Order follows the input `texts` order (single-array response), so no
      // per-item index to sort by — unlike OpenAI.
      const json = JSON.parse(text) as { embeddings?: number[][] };
      const rows = json.embeddings ?? [];
      return { embeddings: rows.map((values) => ({ values })) };
    },
  };
}
