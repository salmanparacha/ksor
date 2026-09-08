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

  it("paces > 60 real document-intent embeds under the cap: no 429, expected duration", async () => {
    const credentials = async () => ({
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
      sessionToken: process.env["AWS_SESSION_TOKEN"] || undefined,
    });
    // Drive the ACTUAL provider document path — this is what ingest calls, so
    // the pacer is wired exactly as in production (per-call, intent-scoped),
    // not hand-passed. KSOR_BEDROCK_MAX_RPM defaults to 50.
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
    const rpm = Number.parseInt(process.env["KSOR_BEDROCK_MAX_RPM"] ?? "50", 10);
    const N = 66; // > Titan V2's 60/min cap: an unpaced burst 429s here
    const input = Array.from({ length: N }, (_, i) => `paced document embed ${i}`);
    const t0 = Date.now();
    // No throw == no 429 survived retry (429 IS fatal on ingest via isFatal),
    // so completion is itself the "no 429" assertion.
    const out = await provider.embed(input, { intent: "document" });
    const elapsedMs = Date.now() - t0;
    const embedded = out.filter((v) => v.length === 1024).length;
    expect(embedded).toBe(N);
    // Strict schedule: N calls take at least (N-1) * (60000/rpm) ms. Allow a
    // small tolerance for clock granularity; the point is it is PACED, not
    // bursted (an unpaced run would finish in a few seconds — and 429).
    const minMs = (N - 1) * (60_000 / rpm);
    expect(elapsedMs).toBeGreaterThanOrEqual(minMs * 0.9);
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
