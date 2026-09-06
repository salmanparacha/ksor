/**
 * The Bedrock Cohere embedding adapter — a keyless (SigV4/IAM) vendor behind
 * the seam, and the second ASYMMETRIC one after Gemini.
 *
 * It needed no change to `EmbeddingProvider`, to the framework's
 * normalization, to the degeneracy check, or to the persisted identity of an
 * embedding space — which is `modelId` + column dimension and never the
 * vendor. The default shipped space is unchanged (decision 30); this is an
 * instance-declared alternative, chosen with `embedding.provider:
 * bedrock-cohere` and its own `embedding.model` / `embedding.dim`.
 *
 * WHAT AN ADOPTER MUST KNOW: a different provider is a DIFFERENT EMBEDDING
 * SPACE. Every stored vector must be re-embedded and every calibrated
 * `vector_floor` re-measured — the product invariant forbids copying a
 * calibrated constant between spaces. The schema records `embedding_model` per
 * generation, so a mismatch is caught rather than served.
 *
 * ASYMMETRIC like Gemini: `input_type` (`search_document` / `search_query`)
 * produces different vectors for the same text, so the intent picks the label
 * AND the timeout. Mis-routing a plane here is a real correctness risk — this
 * is exactly the case the empty-label shortcut does NOT cover.
 *
 * AUTH: the AWS credential chain via a `CredentialProvider`, not an API key.
 * The registry row is keyless; there is no `GEMINI_API_KEY`-shaped env for it.
 */

import type { EmbeddingProvider, Intent } from "../embedding.js";
import {
  bedrockCohereRestEmbedClient,
  BedrockHttpError,
  type BedrockCohereEmbedClient,
  type CredentialProvider,
} from "./bedrock-cohere-rest.js";

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
 * Deliberately the same shape as the other adapters', because the two planes
 * are a property of ksor, not of a vendor.
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
}
