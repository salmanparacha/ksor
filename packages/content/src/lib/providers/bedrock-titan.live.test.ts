/**
 * LIVE Titan InvokeModel smoke test — proves the SigV4 canonical-URI fix works
 * against REAL Bedrock in us-east-1, not just the frozen known-answer. Gated on
 * KSOR_LIVE_BEDROCK=1 plus resolvable AWS credentials in the environment
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN), so it is
 * skipped by default and run deliberately. The regression it guards is the one
 * that shipped a 403 SignatureDoesNotMatch on every Titan embed: the model id
 * `amazon.titan-embed-text-v2:0` contains a `:`, and signing the single-encoded
 * wire path instead of the double-encoded canonical URI made Bedrock reject it.
 */

import { describe, expect, it } from "vitest";

import { bedrockTitanRestEmbedClient } from "./bedrock-titan-rest.js";
import { ingestPacer } from "./bedrock-rest.js";
import { BedrockTitanEmbeddingProvider } from "./bedrock-titan.js";

const live =
  process.env["KSOR_LIVE_BEDROCK"] === "1" && (process.env["AWS_ACCESS_KEY_ID"] ?? "") !== "";

describe.runIf(live)("Titan V2 — live Bedrock InvokeModel (us-east-1)", () => {
  it("embeds a real 1024-dim vector through the fixed SigV4 signer", async () => {
    const credentials = async () => ({
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
      sessionToken: process.env["AWS_SESSION_TOKEN"] || undefined,
    });
    const client = bedrockTitanRestEmbedClient({ region: "us-east-1", credentials });
    const res = await client.embed({
      model: "amazon.titan-embed-text-v2:0",
      input: ["KSoR live SigV4 smoke test for the AWS HealthLake Developer Guide."],
      dimensions: 1024,
      timeoutMs: 20000,
    });
    const v = res.embeddings[0]?.values;
    expect(Array.isArray(v)).toBe(true);
    expect(v!.length).toBe(1024);
  });

  it("embeds a burst above the per-minute cap without a 429, when paced", async () => {
    const credentials = async () => ({
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
      sessionToken: process.env["AWS_SESSION_TOKEN"] || undefined,
    });
    // 70 calls > Titan V2's 60/min cap; unpaced this 429s (reproduced live).
    // With the shared pacer (KSOR_BEDROCK_MAX_RPM, default 50) the run does not
    // throw — the pacer keeps it under the cap, so every input embeds.
    const client = bedrockTitanRestEmbedClient({
      region: "us-east-1",
      credentials,
      pace: ingestPacer(),
    });
    const input = Array.from({ length: 70 }, (_, i) => `paced ingest probe chunk ${i}`);
    const res = await client.embed({
      model: "amazon.titan-embed-text-v2:0",
      input,
      dimensions: 1024,
      timeoutMs: 20000,
    });
    const embedded = res.embeddings.filter(
      (e) => Array.isArray(e.values) && e.values!.length === 1024,
    ).length;
    expect(embedded).toBe(70);
  }, 180_000);

  it("a query-intent embed through the provider is NOT paced (returns promptly)", async () => {
    const credentials = async () => ({
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
      sessionToken: process.env["AWS_SESSION_TOKEN"] || undefined,
    });
    const provider = new BedrockTitanEmbeddingProvider({
      modelId: "amazon.titan-embed-text-v2:0",
      dim: 1024,
      documentTaskLabel: "",
      queryTaskLabel: "",
      documentTimeoutS: 20,
      queryTimeoutS: 20,
      region: "us-east-1",
      credentials,
    });
    // A query embed must NOT touch the ingest pacer, so it returns in well under
    // a second of network time — never delayed by a pacing bucket the ingest
    // plane is draining.
    const t0 = Date.now();
    const out = await provider.embed(["a live query, unpaced"], { intent: "query" });
    const elapsedMs = Date.now() - t0;
    expect(out[0]!.length).toBe(1024);
    expect(elapsedMs).toBeLessThan(3000);
  }, 30_000);
});

describe.runIf(!live)("Titan V2 — live Bedrock (gated)", () => {
  it("skipped — set KSOR_LIVE_BEDROCK=1 with AWS creds in env to run the live proof", () => {
    expect(true).toBe(true);
  });
});
