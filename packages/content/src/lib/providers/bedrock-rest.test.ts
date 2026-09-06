/**
 * The model-neutral Bedrock transport: deterministic SigV4 (fixed clock +
 * credentials produce a byte-stable Authorization), an OPAQUE body it neither
 * inspects nor reshapes (that is what makes it model-neutral — Titan and Cohere
 * hand it different JSON), vendor-message error mapping, and the shared
 * plane-aware retry classifier.
 */

import { describe, expect, it } from "vitest";

import {
  BedrockHttpError,
  bedrockInvokeModel,
  isRetryable,
  isRetryableQuery,
  type BedrockTransportOptions,
} from "./bedrock-rest.js";

// A pinned instant → amzDate "20260115T120000Z", dateStamp "20260115".
const FIXED_CLOCK = (): Date => new Date("2026-01-15T12:00:00.000Z");

function capturingFetch(response: Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body as string,
    });
    return response.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const stsCreds: BedrockTransportOptions["credentials"] = async () => ({
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretkey",
  sessionToken: "SESSION",
});

describe("deterministic SigV4 with fixed time and credentials", () => {
  it("derives amzDate and scope from the pinned clock and signs stably", async () => {
    const okBody = JSON.stringify({ embedding: [0.1, 0.2] });
    const { impl, calls } = capturingFetch(new Response(okBody, { status: 200 }));
    const opts: BedrockTransportOptions = {
      region: "us-east-1",
      credentials: stsCreds,
      fetchImpl: impl,
      clock: FIXED_CLOCK,
    };

    await bedrockInvokeModel(opts, {
      model: "amazon.titan-embed-text-v2:0",
      body: "{}",
      timeoutMs: 1000,
    });
    // A second identical call — the signature must be byte-identical, which is
    // the property "deterministic with fixed time/credentials" actually means.
    const { impl: impl2, calls: calls2 } = capturingFetch(new Response(okBody, { status: 200 }));
    await bedrockInvokeModel(
      { ...opts, fetchImpl: impl2 },
      {
        model: "amazon.titan-embed-text-v2:0",
        body: "{}",
        timeoutMs: 1000,
      },
    );

    const auth = calls[0]!.headers["authorization"]!;
    expect(calls[0]!.headers["x-amz-date"]).toBe("20260115T120000Z");
    expect(auth).toContain("Credential=AKIAEXAMPLE/20260115/us-east-1/bedrock/aws4_request");
    expect(auth).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    // Determinism: same inputs → same header, across a fresh call.
    expect(calls2[0]!.headers["authorization"]).toBe(auth);
    // The security token is sent when present.
    expect(calls[0]!.headers["x-amz-security-token"]).toBe("SESSION");
    expect(calls[0]!.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke",
    );
  });

  it("a different instant produces a different signature", async () => {
    const okBody = JSON.stringify({ embedding: [0.1] });
    const base: BedrockTransportOptions = { region: "us-east-1", credentials: stsCreds };
    const a = capturingFetch(new Response(okBody, { status: 200 }));
    const b = capturingFetch(new Response(okBody, { status: 200 }));
    await bedrockInvokeModel(
      { ...base, fetchImpl: a.impl, clock: FIXED_CLOCK },
      {
        model: "m",
        body: "{}",
        timeoutMs: 1000,
      },
    );
    await bedrockInvokeModel(
      { ...base, fetchImpl: b.impl, clock: (): Date => new Date("2026-01-15T12:00:01.000Z") },
      { model: "m", body: "{}", timeoutMs: 1000 },
    );
    expect(a.calls[0]!.headers["authorization"]).not.toBe(b.calls[0]!.headers["authorization"]);
  });

  it("omits the security-token header for long-lived credentials", async () => {
    const { impl, calls } = capturingFetch(
      new Response(JSON.stringify({ embedding: [0.1] }), { status: 200 }),
    );
    await bedrockInvokeModel(
      {
        region: "us-east-1",
        credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "sk" }),
        fetchImpl: impl,
        clock: FIXED_CLOCK,
      },
      { model: "m", body: "{}", timeoutMs: 1000 },
    );
    expect(calls[0]!.headers["x-amz-security-token"]).toBeUndefined();
    expect(calls[0]!.headers["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,",
    );
  });
});

describe("model-neutrality", () => {
  it("sends the caller's body verbatim and returns the parsed JSON untouched", async () => {
    const titanBody = JSON.stringify({ inputText: "hi", dimensions: 1024, normalize: true });
    const { impl, calls } = capturingFetch(
      new Response(JSON.stringify({ embedding: [0.5, 0.5], inputTextTokenCount: 1 }), {
        status: 200,
      }),
    );
    const out = (await bedrockInvokeModel(
      { region: "us-east-1", credentials: stsCreds, fetchImpl: impl, clock: FIXED_CLOCK },
      { model: "amazon.titan-embed-text-v2:0", body: titanBody, timeoutMs: 1000 },
    )) as { embedding: number[]; inputTextTokenCount: number };
    // Verbatim body: the transport did not reshape a Titan payload into a Cohere one.
    expect(calls[0]!.body).toBe(titanBody);
    expect(out.embedding).toEqual([0.5, 0.5]);
    expect(out.inputTextTokenCount).toBe(1);
  });
});

describe("error mapping", () => {
  it("throws BedrockHttpError carrying the status and vendor message on a non-2xx", async () => {
    const { impl } = capturingFetch(
      new Response(JSON.stringify({ message: "ValidationException: too long" }), { status: 400 }),
    );
    await expect(
      bedrockInvokeModel(
        { region: "us-east-1", credentials: stsCreds, fetchImpl: impl, clock: FIXED_CLOCK },
        { model: "m", body: "{}", timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/400.*too long/);
  });
});

describe("shared retry planes", () => {
  it("ingest retries throttling (429) and 5xx, not 4xx", () => {
    expect(isRetryable(new BedrockHttpError(429, "throttled"))).toBe(true);
    expect(isRetryable(new BedrockHttpError(503, "unavailable"))).toBe(true);
    expect(isRetryable(new BedrockHttpError(400, "bad"))).toBe(false);
  });

  it("read never retries 429 but does retry 5xx and transport blips", () => {
    expect(isRetryableQuery(new BedrockHttpError(429, "throttled"))).toBe(false);
    expect(isRetryableQuery(new BedrockHttpError(503, "unavailable"))).toBe(true);
    const blip = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isRetryableQuery(blip)).toBe(true);
    expect(isRetryable(blip)).toBe(true);
  });
});
