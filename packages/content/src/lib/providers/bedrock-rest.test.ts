/**
 * The model-neutral Bedrock transport: deterministic SigV4 (fixed clock +
 * credentials produce a byte-stable Authorization), an OPAQUE body it neither
 * inspects nor reshapes (that is what makes it model-neutral — Titan and Cohere
 * hand it different JSON), vendor-message error mapping, and the shared
 * plane-aware retry classifier.
 */

import { describe, expect, it } from "vitest";

import {
  BedrockCredentialsError,
  BedrockHttpError,
  bedrockInvokeModel,
  isFatal,
  isRetryable,
  isRetryableQuery,
  makeRpmPacer,
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

describe("fatal (account-level) classification", () => {
  it("401 and 403 are FATAL — the drain aborts rather than quarantining chunks", () => {
    expect(isFatal(new BedrockHttpError(401, "invalid signature"))).toBe(true);
    expect(isFatal(new BedrockHttpError(403, "AccessDeniedException"))).toBe(true);
  });

  it("a credential-resolution failure is FATAL", () => {
    expect(isFatal(new BedrockCredentialsError("no creds"))).toBe(true);
  });

  it("a throttle, a 5xx, a 400 and a transport blip are NOT fatal", () => {
    expect(isFatal(new BedrockHttpError(429, "throttled"))).toBe(false);
    expect(isFatal(new BedrockHttpError(503, "unavailable"))).toBe(false);
    expect(isFatal(new BedrockHttpError(400, "validation"))).toBe(false);
    expect(isFatal(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isFatal("not an error")).toBe(false);
  });

  it("401/403 are also non-retryable on both planes (fatal beats retry)", () => {
    for (const status of [401, 403]) {
      expect(isRetryable(new BedrockHttpError(status, "auth")), `ingest ${status}`).toBe(false);
      expect(isRetryableQuery(new BedrockHttpError(status, "auth")), `read ${status}`).toBe(false);
    }
  });
});

/**
 * REGRESSION (#SigV4 double-encoding). A model id contains a reserved char —
 * `amazon.titan-embed-text-v2:0` has a `:` — and SigV4's canonical URI is NOT
 * the wire path: the wire path single-encodes the segment (`:` -> `%3A`), and
 * the canonical URI used in the string-to-sign encodes it AGAIN (`%3A` ->
 * `%253A`), per the AWS SigV4 rule for every service except S3. Signing over
 * the single-encoded path (as the wire URL) makes Bedrock reject every Titan
 * InvokeModel with 403 SignatureDoesNotMatch, because Bedrock canonicalizes the
 * double-encoded form. This test pins BOTH: the wire URL keeps `%3A`, and the
 * signature matches an independent reference computed over the `%253A`
 * canonical URI. It fails against a signer that conflates the two.
 */
describe("SigV4 canonical URI is double-encoded, wire URI is single-encoded (#reserved-char model id)", () => {
  const KAT_BODY = JSON.stringify({ inputText: "hello", dimensions: 1024, normalize: true });
  // Independent reference signature computed over the DOUBLE-ENCODED canonical
  // URI /model/amazon.titan-embed-text-v2%253A0/invoke for the pinned inputs.
  const KAT_AUTHORIZATION_TITAN =
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260115/us-east-1/bedrock/aws4_request, " +
    "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
    "Signature=99b78e974531b72ed4e049d5c1497025f77c5b682d82b3c5a2ccfd287da01e52";

  it("keeps %3A on the wire but signs the %253A canonical URI", async () => {
    const { impl, calls } = capturingFetch(
      new Response(JSON.stringify({ embedding: [0] }), { status: 200 }),
    );
    await bedrockInvokeModel(
      {
        region: "us-east-1",
        credentials: async () => ({
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        }),
        fetchImpl: impl,
        clock: () => new Date("2026-01-15T12:00:00.000Z"),
      },
      { model: "amazon.titan-embed-text-v2:0", body: KAT_BODY, timeoutMs: 1000 },
    );
    // Wire path: single-encoded ':' -> '%3A' (NOT double-encoded).
    expect(calls[0]!.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke",
    );
    // Signature: computed over the double-encoded '%253A' canonical URI.
    expect(calls[0]!.headers["authorization"]).toBe(KAT_AUTHORIZATION_TITAN);
  });
});

/**
 * KNOWN-ANSWER TEST. The expected Authorization was computed by a SEPARATE,
 * from-scratch SigV4 implementation (not this module's signer) for pinned
 * inputs, and is frozen here as a literal. If `bedrockInvokeModel`'s signing
 * ever drifts — a header reordered, the scope malformed, the payload hash
 * miscomputed — this breaks with the exact byte difference. Inputs: the AWS
 * example access key, region us-east-1, service bedrock, a fixed clock and a
 * fixed Titan body, long-lived credentials (no session token). The model id
 * contains a `:`, so the signature is over the DOUBLE-ENCODED canonical URI
 * /model/amazon.titan-embed-text-v2%253A0/invoke.
 */
describe("SigV4 known-answer (independent reference)", () => {
  const KAT_BODY = JSON.stringify({ inputText: "hello", dimensions: 1024, normalize: true });
  const KAT_PAYLOAD_SHA256 = "a9a850aef577d262f26171c29ce07b91152cf6b2b0e7d75308c4f9c52c5c2866";
  const KAT_AUTHORIZATION =
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260115/us-east-1/bedrock/aws4_request, " +
    "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
    "Signature=99b78e974531b72ed4e049d5c1497025f77c5b682d82b3c5a2ccfd287da01e52";

  it("produces the frozen Authorization header for the pinned request", async () => {
    const { impl, calls } = capturingFetch(
      new Response(JSON.stringify({ embedding: [0] }), { status: 200 }),
    );
    await bedrockInvokeModel(
      {
        region: "us-east-1",
        credentials: async () => ({
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        }),
        fetchImpl: impl,
        clock: () => new Date("2026-01-15T12:00:00.000Z"),
      },
      { model: "amazon.titan-embed-text-v2:0", body: KAT_BODY, timeoutMs: 1000 },
    );
    expect(calls[0]!.headers["x-amz-content-sha256"]).toBe(KAT_PAYLOAD_SHA256);
    expect(calls[0]!.headers["authorization"]).toBe(KAT_AUTHORIZATION);
  });
});

/**
 * RATE LIMITING (#429). Titan V2's on-demand cap is 60 requests/min and is NOT
 * adjustable, so a burst of sequential InvokeModel calls trips it and the ingest
 * refuses. The transport takes an injectable `pace` hook, called once before
 * every InvokeModel request, so production can throttle to a safe rate while
 * tests assert the pacing deterministically (no wall-clock timing).
 */
describe("per-call pacing hook", () => {
  it("awaits the pace hook before each InvokeModel request", async () => {
    const order: string[] = [];
    const { impl } = capturingFetch(
      new Response(JSON.stringify({ embedding: [0] }), { status: 200 }),
    );
    const fetchImpl = (async (url: string, init: RequestInit) => {
      order.push("fetch");
      return (await impl(url, init)) as Response;
    }) as unknown as typeof fetch;
    await bedrockInvokeModel(
      {
        region: "us-east-1",
        credentials: stsCreds,
        fetchImpl,
        clock: FIXED_CLOCK,
        pace: async () => {
          order.push("pace");
        },
      },
      { model: "m", body: "{}", timeoutMs: 1000 },
    );
    // The pace hook ran, and it ran BEFORE the network call.
    expect(order).toEqual(["pace", "fetch"]);
  });
});

/**
 * The strict paced schedule `makeRpmPacer` releases at most one call per
 * `60000/rpm` ms (capacity one, no burst). With a pinned clock it is
 * deterministic: the first call passes at t0, and the Nth call cannot be
 * released before `t0 + (N-1) * interval`.
 */
describe("makeRpmPacer strict paced schedule", () => {
  it("at 50 rpm, request 51 cannot occur before 60 s after request 1", async () => {
    // 50 rpm => interval 1200 ms. A driven clock: sleeps advance virtual time,
    // and each call records the virtual instant at which it was released.
    let nowMs = 0;
    const releaseTimes: number[] = [];
    const pacer = makeRpmPacer(50, {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms; // sleeping advances the clock
      },
    });
    for (let i = 0; i < 51; i++) {
      await pacer();
      releaseTimes.push(nowMs);
    }
    // Request 1 is released at t=0; request 51 is the 50th interval later.
    expect(releaseTimes[0]).toBe(0);
    // 50 intervals * 1200 ms = 60000 ms. Request 51 must be at or after 60 s.
    expect(releaseTimes[50]).toBeGreaterThanOrEqual(60_000);
    // And it is not released EARLY — exactly on the schedule for a pinned clock.
    expect(releaseTimes[50]).toBe(60_000);
  });

  it("the first call passes immediately; the second waits one interval (no burst)", async () => {
    let nowMs = 5_000;
    const sleeps: number[] = [];
    const pacer = makeRpmPacer(60, {
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    await pacer(); // first: no wait
    expect(sleeps).toEqual([]);
    await pacer(); // second: waits one 1000 ms interval (60 rpm => 1000 ms)
    expect(sleeps).toEqual([1000]);
  });

  it("rpm <= 0 disables pacing (never waits)", async () => {
    const sleeps: number[] = [];
    const pacer = makeRpmPacer(0, { now: () => 0, sleep: async (ms) => void sleeps.push(ms) });
    for (let i = 0; i < 1000; i++) await pacer();
    expect(sleeps).toEqual([]);
  });
});
