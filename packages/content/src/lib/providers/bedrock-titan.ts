/**
 * The Bedrock Titan V2 embedding adapter — a keyless (SigV4/IAM) vendor behind
 * the seam, and the production embedding model for the HealthLake deployment
 * (#Titan). It needed no change to `EmbeddingProvider`, to the framework's
 * normalization, to the degeneracy check, or to the persisted identity of an
 * embedding space — which is `modelId` + column dimension and never the vendor.
 *
 * Selected with `embedding.provider: bedrock-titan`; the default shipped space
 * is unchanged (decision 30). Switching to it is a re-embed of the whole corpus
 * and a re-measured floor — a different provider is a different space, and the
 * schema records `embedding_model` per generation so a mismatch is caught
 * rather than served.
 *
 * SYMMETRIC, like OpenAI and unlike Cohere/Gemini: no `input_type`, so both
 * task labels are the empty string — the case `lib/embedding.ts` names as the
 * one that cannot mis-route a plane. The intent still reaches this adapter and
 * still picks the TIMEOUT, because that follows the plane, not the vendor.
 *
 * AUTH: the AWS credential chain via a `CredentialProvider`, not an API key.
 * The registry row is keyless. Retry classification is shared with Cohere in
 * `bedrock-rest.ts` — the two planes are a property of ksor, not of a vendor.
 */

import type { EmbeddingProvider, Intent } from "../embedding.js";
import {
  ingestPacer,
  isFatal,
  isRetryable,
  isRetryableQuery,
  type CredentialProvider,
} from "./bedrock-rest.js";
import { bedrockTitanRestEmbedClient, type BedrockTitanEmbedClient } from "./bedrock-titan-rest.js";

// Re-exported so the plane taxonomy has one name here too; the implementation
// lives once, in the shared transport.
export { isFatal, isRetryable, isRetryableQuery } from "./bedrock-rest.js";

export interface BedrockTitanEmbeddingProviderOptions {
  modelId: string;
  dim: number;
  /** Symmetric vendor: empty. Carried (not forced) so the recipe describes the
   * space the registry declared, exactly as the OpenAI adapter does. */
  documentTaskLabel: string;
  queryTaskLabel: string;
  region: string;
  credentials: CredentialProvider;
  documentTimeoutS: number;
  queryTimeoutS: number;
  /** Test seam / boundary wrap: defaults to building the real REST client. */
  clientFactory?: () => BedrockTitanEmbedClient;
}

export class BedrockTitanEmbeddingProvider implements EmbeddingProvider {
  readonly providerId: string = "bedrock-titan";
  readonly modelId: string;
  readonly dim: number;
  readonly documentTaskLabel: string;
  readonly queryTaskLabel: string;
  private readonly documentTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly clientFactory: () => BedrockTitanEmbedClient;
  private client: BedrockTitanEmbedClient | null = null;

  constructor(opts: BedrockTitanEmbeddingProviderOptions) {
    this.modelId = opts.modelId;
    this.dim = opts.dim;
    this.documentTaskLabel = opts.documentTaskLabel;
    this.queryTaskLabel = opts.queryTaskLabel;
    this.documentTimeoutMs = Math.trunc(opts.documentTimeoutS * 1000);
    this.queryTimeoutMs = Math.trunc(opts.queryTimeoutS * 1000);
    this.clientFactory =
      opts.clientFactory ??
      ((): BedrockTitanEmbedClient =>
        bedrockTitanRestEmbedClient({
          region: opts.region,
          credentials: opts.credentials,
          pace: ingestPacer(),
        }));
  }

  get recipe(): string {
    return `${this.modelId}/d${this.dim}/${this.documentTaskLabel}`;
  }

  private getClient(): BedrockTitanEmbedClient {
    this.client ??= this.clientFactory();
    return this.client;
  }

  /** DROP the client reference, never close it. Idempotent. */
  reset(): void {
    this.client = null;
  }

  async embed(texts: readonly string[], opts: { intent: Intent }): Promise<number[][]> {
    // Symmetric: the LABEL does not vary, but the TIMEOUT follows the plane the
    // intent names — batch patience for a document, read patience for a query.
    const isDoc = opts.intent === "document";
    const resp = await this.getClient().embed({
      model: this.modelId,
      input: texts,
      dimensions: this.dim,
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
