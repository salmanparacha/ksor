/**
 * The Bedrock Cohere embedding adapter — a keyless (SigV4/IAM) vendor behind
 * the seam, and the second ASYMMETRIC one after Gemini.
 *
 * Post-#Titan it is NOT the production model — Titan V2 is the target space.
 * This adapter is retained as the emergency ROLLBACK target (generation 4) for
 * the cutover observation window, and as the regression baseline proving the
 * shared `bedrock-rest.ts` signer serves two vendors.
 *
 * It needed no change to `EmbeddingProvider`, to the framework's
 * normalization, to the degeneracy check, or to the persisted identity of an
 * embedding space — which is `modelId` + column dimension and never the
 * vendor. Selected with `embedding.provider: bedrock-cohere` and its own
 * `embedding.model` / `embedding.dim`.
 *
 * ASYMMETRIC like Gemini: `input_type` (`search_document` / `search_query`)
 * produces different vectors for the same text, so the intent picks the label
 * AND the timeout. Mis-routing a plane here is a real correctness risk.
 *
 * AUTH: the AWS credential chain via a `CredentialProvider`, not an API key.
 * The registry row is keyless. Retry classification is shared with Titan in
 * `bedrock-rest.ts` — the two planes are a property of ksor, not of a vendor.
 */

import type { EmbeddingProvider, Intent } from "../embedding.js";
import {
  bedrockCohereRestEmbedClient,
  type BedrockCohereEmbedClient,
} from "./bedrock-cohere-rest.js";
import { isFatal, isRetryable, isRetryableQuery, type CredentialProvider } from "./bedrock-rest.js";

// Re-exported so existing importers (and the plane taxonomy's home) keep a
// single name; the implementation lives once, in the shared transport.
export { isFatal, isRetryable, isRetryableQuery } from "./bedrock-rest.js";

export interface BedrockCohereEmbeddingProviderOptions {
  modelId: string;
  dim: number;
  /** The vendor `input_type` for a document embed — e.g. "search_document". */
  documentTaskLabel: string;
  /** The vendor `input_type` for a query embed — e.g. "search_query". */
  queryTaskLabel: string;
  region: string;
  credentials: CredentialProvider;
  documentTimeoutS: number;
  queryTimeoutS: number;
  /** Test seam / boundary wrap: defaults to building the real REST client. */
  clientFactory?: () => BedrockCohereEmbedClient;
}

export class BedrockCohereEmbeddingProvider implements EmbeddingProvider {
  readonly providerId: string = "bedrock-cohere";
  readonly modelId: string;
  readonly dim: number;
  readonly documentTaskLabel: string;
  readonly queryTaskLabel: string;
  private readonly documentTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly clientFactory: () => BedrockCohereEmbedClient;
  private client: BedrockCohereEmbedClient | null = null;

  constructor(opts: BedrockCohereEmbeddingProviderOptions) {
    this.modelId = opts.modelId;
    this.dim = opts.dim;
    this.documentTaskLabel = opts.documentTaskLabel;
    this.queryTaskLabel = opts.queryTaskLabel;
    this.documentTimeoutMs = Math.trunc(opts.documentTimeoutS * 1000);
    this.queryTimeoutMs = Math.trunc(opts.queryTimeoutS * 1000);
    this.clientFactory =
      opts.clientFactory ??
      ((): BedrockCohereEmbedClient =>
        bedrockCohereRestEmbedClient({ region: opts.region, credentials: opts.credentials }));
  }

  get recipe(): string {
    return `${this.modelId}/d${this.dim}/${this.documentTaskLabel}`;
  }

  private getClient(): BedrockCohereEmbedClient {
    this.client ??= this.clientFactory();
    return this.client;
  }

  /** DROP the client reference, never close it. Idempotent. */
  reset(): void {
    this.client = null;
  }

  async embed(texts: readonly string[], opts: { intent: Intent }): Promise<number[][]> {
    // The LABEL and the TIMEOUT both follow the plane the intent names, exactly
    // as for Gemini — this vendor is asymmetric, so both matter.
    const isDoc = opts.intent === "document";
    const resp = await this.getClient().embed({
      model: this.modelId,
      input: texts,
      inputType: isDoc ? this.documentTaskLabel : this.queryTaskLabel,
      timeoutMs: isDoc ? this.documentTimeoutMs : this.queryTimeoutMs,
    });
    return resp.embeddings.map((e) => [...(e.values ?? [])]);
  }

  isRetryable(exc: unknown): boolean {
    return isRetryable(exc);
  }

  isRetryableQuery(exc: unknown): boolean {
    return isRetryableQuery(exc);
  }

  isFatal(exc: unknown): boolean {
    return isFatal(exc);
  }
}
