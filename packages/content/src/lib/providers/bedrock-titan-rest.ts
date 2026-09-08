/**
 * Amazon Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) — the Titan
 * PAYLOAD SERIALIZATION only. Signing/sending/retry live in the model-neutral
 * `bedrock-rest.ts`; this file builds the Titan request body and unwraps the
 * Titan response around `bedrockInvokeModel`. Titan V2 is the production
 * embedding model post-#Titan; Cohere is retained only as the rollback target.
 *
 * WHAT IS TITAN-SPECIFIC AND STAYS HERE:
 *
 *   ONE inputText PER CALL. Titan V2's `InvokeModel` body is a single
 *   `{ inputText, dimensions, normalize }` — there is no batch array (unlike
 *   Cohere's `texts[]`). So a batch is N sequential invocations, order
 *   preserved. Sequential rather than concurrent keeps ingest inside Titan's
 *   per-account throughput without a burst that turns into 429s the ingest
 *   plane would then have to back off through anyway.
 *
 *   SYMMETRIC. No `input_type` / task label — a query and a document with the
 *   same text embed identically. The intent still picks the plane's TIMEOUT.
 *
 *   NORMALIZE at the vendor (`normalize: true`) AND re-normalize in the
 *   framework contract — the framework's L2 pass is mandatory regardless, so
 *   this is belt-and-suspenders, not a substitute.
 *
 *   HARD INPUT LIMITS, ENFORCED BY REFUSAL, NEVER BY TRUNCATION. Titan V2
 *   documents a 50,000-CHARACTER and an 8,192-TOKEN ceiling per inputText. A
 *   silently truncated input is a silently WRONG vector — the exact failure a
 *   system of record exists to prevent — so an over-length input is REFUSED
 *   (`TitanInputTooLargeError`), not cut like Cohere's 2048-char tail. The
 *   character ceiling is checked here before the call; the token ceiling is
 *   enforced by the vendor (an over-token input returns a 400 that surfaces as
 *   `BedrockHttpError`, an explicit failure), because counting Titan's tokens
 *   client-side would need a tokenizer this package refuses to carry. In
 *   practice KSoR's 4,000-character chunk ceiling keeps every real chunk far
 *   under both — the live ingest still proves each candidate chunk was accepted.
 */

import { bedrockInvokeModel, type BedrockTransportOptions } from "./bedrock-rest.js";

/** Titan V2's documented per-inputText hard character ceiling. */
export const TITAN_V2_MAX_CHARS = 50_000;
/** Titan V2's documented per-inputText hard token ceiling (vendor-enforced;
 * recorded here for provenance, not counted client-side). */
export const TITAN_V2_MAX_TOKENS = 8_192;

/** The stable first stderr line for an over-length Titan input. */
export const TITAN_INPUT_TOO_LARGE = "ksor-titan-input-too-large" as const;

/** A Titan input exceeds a hard ceiling. Thrown BEFORE the call for the
 * character limit; refused rather than truncated so no silently-wrong vector
 * is ever stored. */
export class TitanInputTooLargeError extends Error {
  readonly slug: typeof TITAN_INPUT_TOO_LARGE = TITAN_INPUT_TOO_LARGE;
  readonly chars: number;
  constructor(chars: number) {
    super(
      `Titan input of ${chars} characters exceeds the ${TITAN_V2_MAX_CHARS}-character hard limit — ` +
        `refusing rather than truncating (a silently cut embedding is a silently wrong vector). ` +
        `Re-chunk the source; KSoR's 4,000-character chunk ceiling keeps real chunks well under this.`,
    );
    this.name = "TitanInputTooLargeError";
    this.chars = chars;
  }
}

/** The slice the provider consumes — the same shape the other clients present.
 * Titan is symmetric, so there is no `inputType`; `dimensions` selects the
 * Matryoshka output width (256 / 512 / 1024). */
export interface BedrockTitanEmbedClient {
  embed(params: {
    model: string;
    input: readonly string[];
    dimensions: number;
    timeoutMs: number;
    /** Awaited once before each InvokeModel call. The provider passes the
     * shared ingest pacer for `document` intent and OMITS it for `query`, so a
     * read never joins the ingest queue. */
    pace?: () => Promise<void>;
  }): Promise<{ embeddings: ReadonlyArray<{ values?: number[] }> }>;
}

export function bedrockTitanRestEmbedClient(
  opts: BedrockTransportOptions,
): BedrockTitanEmbedClient {
  return {
    async embed(params) {
      // Titan embeds ONE inputText per InvokeModel call; a batch is N calls,
      // order preserved. Refuse an over-length input before spending the call.
      const out: Array<{ values?: number[] }> = [];
      for (const text of params.input) {
        if (text.length > TITAN_V2_MAX_CHARS) {
          throw new TitanInputTooLargeError(text.length);
        }
        const body = JSON.stringify({
          inputText: text,
          dimensions: params.dimensions,
          normalize: true,
        });
        // Titan response: { embedding: [...N...], inputTextTokenCount }.
        // Pacing is PER CALL (params.pace), set by the provider from intent, so
        // it overrides any transport-level pace.
        const json = (await bedrockInvokeModel(
          { ...opts, pace: params.pace },
          {
            model: params.model,
            body,
            timeoutMs: params.timeoutMs,
          },
        )) as { embedding?: number[] };
        out.push({ values: json.embedding });
      }
      return { embeddings: out };
    },
  };
}
