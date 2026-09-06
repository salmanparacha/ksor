/**
 * Amazon Bedrock's Cohere Embed endpoint — the Cohere PAYLOAD SERIALIZATION
 * only. Signing, sending and error/retry classification live in the
 * model-neutral `bedrock-rest.ts`; this file builds the Cohere request body and
 * unwraps the Cohere response around `bedrockInvokeModel`. That split (#Titan)
 * is decision 13's shape: shared transport, per-vendor payload.
 *
 * COHERE'S ROLE POST-#Titan: not the production model. Titan V2 is the target
 * embedding space; the Cohere adapter is retained as the emergency ROLLBACK
 * target — generation 4 stays served-able for the observation window, then is
 * retired. It is kept green as the regression baseline for the shared signer.
 *
 * WHAT IS COHERE-SPECIFIC AND STAYS HERE:
 *
 *   Cohere v3 embeds ASYMMETRICALLY, like Gemini and unlike OpenAI: the vendor
 *   `input_type` (`search_document` vs `search_query`) produces different
 *   vectors for the same text, and the plane's intent picks which.
 *
 *   CLIENT-SIDE TRUNCATION to 2048 CHARACTERS: Cohere v3 on Bedrock enforces a
 *   hard 2048-character maxLength per text as INPUT SCHEMA validation and
 *   rejects anything longer with a 400 — and the vendor's own `truncate: "END"`
 *   does NOT bypass it (the schema check runs first). A chunk the framework
 *   produced under HARD_MAX_CHARS=4000 would fail, so we cut the tail.
 *
 *   Cohere returns raw vectors (arriving ~L2-normalized); the framework
 *   re-normalizes regardless, so the transport returns them untouched.
 */

import { bedrockInvokeModel, type BedrockTransportOptions } from "./bedrock-rest.js";

/** Retained name for the Cohere client's construction options — the shared
 * transport options, unchanged in shape from before the extraction. */
export type BedrockCohereRestOptions = BedrockTransportOptions;

/** The slice the provider consumes — the same shape the other clients present. */
export interface BedrockCohereEmbedClient {
  embed(params: {
    model: string;
    input: readonly string[];
    inputType: string;
    timeoutMs: number;
  }): Promise<{ embeddings: ReadonlyArray<{ values?: number[] }> }>;
}

export function bedrockCohereRestEmbedClient(
  opts: BedrockCohereRestOptions,
): BedrockCohereEmbedClient {
  return {
    async embed(params) {
      // NO embedding_types → the default `embeddings_floats` shape, a bare
      // `embeddings: [[...]]` array. Asking for a type keys the response by it.
      //
      // Truncate to Cohere v3's hard 2048-character input-schema ceiling (see
      // the file header); `truncate: "END"` is belt-and-suspenders for the
      // separate TOKEN limit on inputs under 2048 chars but over 512 tokens.
      const COHERE_V3_MAX_CHARS = 2048;
      const texts = params.input.map((t) =>
        t.length > COHERE_V3_MAX_CHARS ? t.slice(0, COHERE_V3_MAX_CHARS) : t,
      );
      const body = JSON.stringify({
        texts,
        input_type: params.inputType,
        truncate: "END",
      });

      // Bare `embeddings_floats`: { embeddings: [[...1024...]], ... }. Order
      // follows the input `texts` order (single-array response), so no per-item
      // index to sort by — unlike OpenAI.
      const json = (await bedrockInvokeModel(opts, {
        model: params.model,
        body,
        timeoutMs: params.timeoutMs,
      })) as { embeddings?: number[][] };
      const rows = json.embeddings ?? [];
      return { embeddings: rows.map((values) => ({ values })) };
    },
  };
}
