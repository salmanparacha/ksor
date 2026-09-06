/**
 * The Bedrock Cohere adapter, against a stubbed transport, plus a focused test
 * of the SigV4 signer's canonical form.
 *
 * The assertions worth having are the ones a passing embed would hide:
 *
 *   ASYMMETRY. Unlike OpenAI, this vendor's `input_type` changes the vector,
 *   so the INTENT must reach the wire as the right label — `search_document`
 *   for a document, `search_query` for a query. Mis-routing is a silent
 *   correctness bug: same count, same width, all finite, and a corpus embedded
 *   as if every chunk were a query.
 *
 *   TIMEOUT follows the plane, like every adapter.
 *
 *   RETRY PLANES. 429 (ThrottlingException) is retryable on ingest and never
 *   on read — a property of ksor's planes, not the vendor, so it must hold
 *   identically here.
 *
 *   SIGNING. The canonical request must lowercase-and-sort headers and include
 *   the security-token header only when a session token exists.
 */

import { describe, expect, it } from "vitest";

import { BedrockCohereEmbeddingProvider, isRetryable, isRetryableQuery } from "./bedrock-cohere.js";
import {
  BedrockHttpError,
  bedrockCohereRestEmbedClient,
  type BedrockCohereEmbedClient,
} from "./bedrock-cohere-rest.js";

const opts = {
  modelId: "cohere.embed-english-v3",
  dim: 1024,
  documentTaskLabel: "search_document",
  queryTaskLabel: "search_query",
  region: "ca-central-1",
  credentials: async () => ({ accessKeyId: "AK", secretAccessKey: "SK" }),
  documentTimeoutS: 30,
  queryTimeoutS: 2,
};

function stub(vectors: number[][]) {
  const calls: Array<{ model: string; inputType: string; timeoutMs: number; input: string[] }> = [];
  const client: BedrockCohereEmbedClient = {
    async embed(params) {
      calls.push({
        model: params.model,
        inputType: params.inputType,
        timeoutMs: params.timeoutMs,
        input: [...params.input],
      });
      return { embeddings: vectors.map((values) => ({ values })) };
    },
  };
  return { client, calls };
}

describe("what reaches the wire", () => {
  it("a document intent sends input_type=search_document and the batch timeout", async () => {
    const { client, calls } = stub([[1, 0, 0, 0]]);
    const p = new BedrockCohereEmbeddingProvider({ ...opts, clientFactory: () => client });
    await p.embed(["hello"], { intent: "document" });
    expect(calls[0]!.inputType).toBe("search_document");
    expect(calls[0]!.timeoutMs).toBe(30_000);
    expect(calls[0]!.model).toBe("cohere.embed-english-v3");
  });

  it("a query intent sends input_type=search_query and the read timeout", async () => {
    const { client, calls } = stub([[0, 1, 0, 0]]);
    const p = new BedrockCohereEmbeddingProvider({ ...opts, clientFactory: () => client });
    await p.embed(["hello"], { intent: "query" });
    expect(calls[0]!.inputType).toBe("search_query");
    expect(calls[0]!.timeoutMs).toBe(2_000);
  });

  it("returns raw vectors positionally, one per input", async () => {
    const { client } = stub([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    const p = new BedrockCohereEmbeddingProvider({ ...opts, clientFactory: () => client });
    const out = await p.embed(["a", "b"], { intent: "document" });
    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  it("recipe is model/dim/document-label", () => {
    const p = new BedrockCohereEmbeddingProvider({ ...opts });
    expect(p.recipe).toBe("cohere.embed-english-v3/d1024/search_document");
    expect(p.providerId).toBe("bedrock-cohere");
  });
});

describe("retry planes", () => {
  it("ingest retries throttling (429) and 5xx, not 4xx", () => {
    expect(isRetryable(new BedrockHttpError(429, "throttled"))).toBe(true);
    expect(isRetryable(new BedrockHttpError(503, "unavailable"))).toBe(true);
    expect(isRetryable(new BedrockHttpError(400, "bad"))).toBe(false);
    expect(isRetryable(new BedrockHttpError(403, "denied"))).toBe(false);
  });

  it("read NEVER retries 429 — a throttled account stays throttled next second", () => {
    expect(isRetryableQuery(new BedrockHttpError(429, "throttled"))).toBe(false);
    expect(isRetryableQuery(new BedrockHttpError(503, "unavailable"))).toBe(true);
  });

  it("both planes retry a transport blip", () => {
    const blip = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isRetryable(blip)).toBe(true);
    expect(isRetryableQuery(blip)).toBe(true);
  });
});

describe("SigV4 signing (via a captured fetch)", () => {
  it("signs a request: authorization header, sorted lowercase signed headers, security token when present", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = {
        url,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      };
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = bedrockCohereRestEmbedClient({
      region: "ca-central-1",
      credentials: async () => ({
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
        sessionToken: "TOKEN",
      }),
      fetchImpl: fakeFetch,
    });
    const out = await client.embed({
      model: "cohere.embed-english-v3",
      input: ["hello"],
      inputType: "search_document",
      timeoutMs: 30_000,
    });
    expect(out.embeddings).toEqual([{ values: [0.1, 0.2, 0.3] }]);

    const c = captured!;
    expect(c.url).toBe(
      "https://bedrock-runtime.ca-central-1.amazonaws.com/model/cohere.embed-english-v3/invoke",
    );
    expect(c.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
    // The signed headers list is sorted, lowercase, and includes the token header.
    expect(c.headers["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
    expect(c.headers["x-amz-security-token"]).toBe("TOKEN");
    expect(JSON.parse(c.body)).toEqual({
      texts: ["hello"],
      input_type: "search_document",
      truncate: "END",
    });
  });

  it("omits the security-token header for long-lived credentials", async () => {
    let captured: Record<string, string> | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = bedrockCohereRestEmbedClient({
      region: "us-east-1",
      credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetchImpl: fakeFetch,
    });
    await client.embed({ model: "m", input: ["x"], inputType: "search_query", timeoutMs: 1000 });
    expect(captured!["x-amz-security-token"]).toBeUndefined();
    expect(captured!["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(captured!["authorization"]).not.toContain("x-amz-security-token");
  });

  it("throws BedrockHttpError with the vendor message on a non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "ThrottlingException: slow down" }), {
        status: 429,
      })) as unknown as typeof fetch;
    const client = bedrockCohereRestEmbedClient({
      region: "us-east-1",
      credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetchImpl: fakeFetch,
    });
    await expect(
      client.embed({ model: "m", input: ["x"], inputType: "search_document", timeoutMs: 1000 }),
    ).rejects.toThrow(/429.*slow down/);
  });
});
