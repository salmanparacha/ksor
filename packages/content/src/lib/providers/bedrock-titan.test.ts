/**
 * The Bedrock Titan V2 adapter, against a stubbed transport, plus the REST
 * client's body serialization, its per-text batching, and its hard-limit
 * REFUSAL — the assertions a passing embed would hide.
 *
 *   SYMMETRY. Unlike Cohere, Titan has no `input_type`: a query and a document
 *   with the same text embed identically. The recipe carries an empty label,
 *   and the TIMEOUT still follows the plane.
 *
 *   PER-TEXT CALLS. Titan V2 embeds ONE inputText per InvokeModel, so a batch
 *   of N produces N signed calls, order preserved.
 *
 *   NO SILENT TRUNCATION. An input over the 50,000-character ceiling is
 *   REFUSED before the call, never cut — a truncated input is a wrong vector.
 *
 *   KEYLESS. The registry row needs no API key and names no key env.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BedrockCredentialsError, BedrockHttpError } from "./bedrock-rest.js";
import { BedrockTitanEmbeddingProvider } from "./bedrock-titan.js";
import {
  bedrockTitanRestEmbedClient,
  TitanInputTooLargeError,
  TITAN_INPUT_TOO_LARGE,
  TITAN_V2_MAX_CHARS,
  type BedrockTitanEmbedClient,
} from "./bedrock-titan-rest.js";
import {
  buildShippedProvider,
  PROVIDERS,
  providerKeyEnv,
  providerNeedsApiKey,
} from "./registry.js";

const opts = {
  modelId: "amazon.titan-embed-text-v2:0",
  dim: 1024,
  documentTaskLabel: "",
  queryTaskLabel: "",
  region: "us-east-1",
  credentials: async () => ({ accessKeyId: "AK", secretAccessKey: "SK" }),
  documentTimeoutS: 30,
  queryTimeoutS: 2,
};

function stub(vectors: number[][]) {
  const calls: Array<{
    model: string;
    dimensions: number;
    timeoutMs: number;
    input: string[];
    paced: boolean;
  }> = [];
  const client: BedrockTitanEmbedClient = {
    async embed(params) {
      calls.push({
        model: params.model,
        dimensions: params.dimensions,
        timeoutMs: params.timeoutMs,
        input: [...params.input],
        paced: params.pace !== undefined,
      });
      return { embeddings: vectors.map((values) => ({ values })) };
    },
  };
  return { client, calls };
}

describe("pacing is intent-scoped (document only, never query)", () => {
  it("a document embed enters the pacer (pace is passed)", async () => {
    const { client, calls } = stub([[1, 0, 0, 0]]);
    const p = new BedrockTitanEmbeddingProvider({ ...opts, clientFactory: () => client });
    await p.embed(["hello"], { intent: "document" });
    expect(calls[0]!.paced).toBe(true);
  });

  it("a query embed NEVER enters the pacer (pace is omitted)", async () => {
    const { client, calls } = stub([[0, 1, 0, 0]]);
    const p = new BedrockTitanEmbeddingProvider({ ...opts, clientFactory: () => client });
    await p.embed(["hello"], { intent: "query" });
    expect(calls[0]!.paced).toBe(false);
  });

  it("a query degrades PROMPTLY under throttling instead of joining the ingest queue", async () => {
    // The read plane must fail fast: no pacing wait, and 429 is NOT retried on a
    // query (isRetryableQuery is false for 429), so a throttled read returns
    // quickly to the caller (which degrades to keyword-only) rather than
    // stalling behind an ingest pacer or a patient retry.
    let paced = false;
    const throttling: BedrockTitanEmbedClient = {
      async embed(params) {
        if (params.pace !== undefined) paced = true;
        throw new BedrockHttpError(429, "Too many requests");
      },
    };
    const p = new BedrockTitanEmbeddingProvider({ ...opts, clientFactory: () => throttling });
    const t0 = Date.now();
    await expect(p.embed(["q"], { intent: "query" })).rejects.toThrow(/429/);
    const elapsedMs = Date.now() - t0;
    expect(paced).toBe(false); // the query never touched the pacer
    expect(p.isRetryableQuery(new BedrockHttpError(429, "x"))).toBe(false); // 429 not retried on read
    expect(elapsedMs).toBeLessThan(500); // returned promptly, no pacing/queue wait
  });
});

describe("what reaches the wire (symmetric)", () => {
  it("a document intent sends dimensions and the batch timeout", async () => {
    const { client, calls } = stub([[1, 0, 0, 0]]);
    const p = new BedrockTitanEmbeddingProvider({ ...opts, clientFactory: () => client });
    await p.embed(["hello"], { intent: "document" });
    expect(calls[0]!.dimensions).toBe(1024);
    expect(calls[0]!.timeoutMs).toBe(30_000);
    expect(calls[0]!.model).toBe("amazon.titan-embed-text-v2:0");
  });

  it("a query intent sends the read timeout (same vector either way)", async () => {
    const { client, calls } = stub([[0, 1, 0, 0]]);
    const p = new BedrockTitanEmbeddingProvider({ ...opts, clientFactory: () => client });
    await p.embed(["hello"], { intent: "query" });
    expect(calls[0]!.timeoutMs).toBe(2_000);
  });

  it("returns raw vectors positionally, one per input", async () => {
    const { client } = stub([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    const p = new BedrockTitanEmbeddingProvider({ ...opts, clientFactory: () => client });
    const out = await p.embed(["a", "b"], { intent: "document" });
    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  it("recipe is model/dim/ with an empty label; providerId is bedrock-titan", () => {
    const p = new BedrockTitanEmbeddingProvider({ ...opts });
    expect(p.recipe).toBe("amazon.titan-embed-text-v2:0/d1024/");
    expect(p.providerId).toBe("bedrock-titan");
  });

  it("classifies 401/403 and credential failures as FATAL (aborts the drain), 429 as not", () => {
    const p = new BedrockTitanEmbeddingProvider({ ...opts });
    expect(p.isFatal?.(new BedrockHttpError(403, "AccessDeniedException"))).toBe(true);
    expect(p.isFatal?.(new BedrockHttpError(401, "invalid signature"))).toBe(true);
    expect(p.isFatal?.(new BedrockCredentialsError("no creds"))).toBe(true);
    expect(p.isFatal?.(new BedrockHttpError(429, "throttled"))).toBe(false);
  });
});

describe("REST client: Titan body serialization and per-text batching", () => {
  it("serializes { inputText, dimensions, normalize } and invokes once per text in order", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      const vec = n === 0 ? [0.1, 0.2] : [0.3, 0.4];
      n++;
      return new Response(JSON.stringify({ embedding: vec, inputTextTokenCount: 3 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = bedrockTitanRestEmbedClient({
      region: "us-east-1",
      credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetchImpl: fakeFetch,
    });
    const out = await client.embed({
      model: "amazon.titan-embed-text-v2:0",
      input: ["first", "second"],
      dimensions: 1024,
      timeoutMs: 30_000,
    });

    expect(bodies).toHaveLength(2); // one InvokeModel per inputText
    expect(JSON.parse(bodies[0]!)).toEqual({
      inputText: "first",
      dimensions: 1024,
      normalize: true,
    });
    expect(JSON.parse(bodies[1]!)).toEqual({
      inputText: "second",
      dimensions: 1024,
      normalize: true,
    });
    expect(out.embeddings).toEqual([{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }]);
  });

  it("REFUSES an over-length input before calling the wire — never truncates", async () => {
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ embedding: [0] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = bedrockTitanRestEmbedClient({
      region: "us-east-1",
      credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetchImpl: fakeFetch,
    });
    const tooLong = "x".repeat(TITAN_V2_MAX_CHARS + 1);
    await expect(
      client.embed({ model: "m", input: [tooLong], dimensions: 1024, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(TitanInputTooLargeError);
    // The wire was never touched — refusal, not truncation.
    expect(fetchCalls).toBe(0);
  });

  it("TitanInputTooLargeError carries the stable slug and the char count", () => {
    const err = new TitanInputTooLargeError(60_000);
    expect(err.slug).toBe(TITAN_INPUT_TOO_LARGE);
    expect(err.chars).toBe(60_000);
    expect(err.message).toContain(String(TITAN_V2_MAX_CHARS));
  });

  it("an over-TOKEN input under the char limit surfaces the vendor 400, not a truncation", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "ValidationException: too many input tokens" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const client = bedrockTitanRestEmbedClient({
      region: "us-east-1",
      credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetchImpl: fakeFetch,
    });
    await expect(
      client.embed({ model: "m", input: ["under 50k chars"], dimensions: 1024, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(BedrockHttpError);
  });
});

describe("registry: keyless construction", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      saved[k] = process.env[k];
    }
    process.env["AWS_REGION"] = "us-east-1";
    process.env["AWS_ACCESS_KEY_ID"] = "AKIATEST";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secrettest";
    delete process.env["AWS_SESSION_TOKEN"];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("needs no API key and names no key env", () => {
    expect(providerNeedsApiKey("bedrock-titan")).toBe(false);
    expect(providerKeyEnv("bedrock-titan")).toBeNull();
    expect(PROVIDERS["bedrock-titan"]!.taskLabels).toEqual({ document: "", query: "" });
  });

  it("builds through buildShippedProvider with apiKey null and the ambient AWS chain", () => {
    const p = buildShippedProvider("bedrock-titan", {
      apiKey: null,
      modelId: "amazon.titan-embed-text-v2:0",
      dim: 1024,
    });
    expect(p.providerId).toBe("bedrock-titan");
    expect(p.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(p.dim).toBe(1024);
    // Symmetric: no task label leaked into the recipe.
    expect(p.recipe).toBe("amazon.titan-embed-text-v2:0/d1024/");
  });
});
