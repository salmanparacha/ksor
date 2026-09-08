---
"@panaversity/ksor": patch
---

fix(bedrock): pace ingest embeds under the per-minute InvokeModel cap

Titan V2's on-demand cap is 60 requests/min and is NOT adjustable, so a fresh
ingest — one InvokeModel per chunk, fired as fast as `fetch` allows — bursts
past it and Bedrock returns 429; the drain's retry cannot clear a sustained
throttle and refuses (`ksor-refused`).

The Bedrock transport now takes an injectable `pace` hook awaited once before
each InvokeModel request, and a shared process-wide STRICT paced schedule
(`ingestPacer` → `makeRpmPacer`, capacity ONE, one release per `60000/rpm` ms,
read from `KSOR_BEDROCK_MAX_RPM`, default 50; set 0 to disable for provisioned
throughput). Capacity one — not a token bucket — because Bedrock enforces a
per-minute RATE, so an initial burst of `rpm` calls still trips it. Because the
cap is per-account, the schedule is shared across vendors. Pacing is passed PER
EMBED CALL and scoped to `intent: "document"` only — a `query` embed NEVER
enters the pacer, so a throttled read still degrades to keyword-only promptly
instead of joining the ingest queue. Pacing happens before the signature
timestamp is fixed, so a paced wait never drifts the SigV4 signature.

Verified by a deterministic schedule test (at 50 rpm, request 51 cannot occur
before 60 s after request 1; no initial burst), a pace-hook ordering test,
intent-scoping tests (document paced, query never paced, query degrades
promptly under throttling), and a gated live proof: 66 real Titan
document-intent embeds through the provider path completing with zero 429s in
the expected paced duration (~78 s at 50 rpm), and a query-intent embed
returning promptly (~0.8 s) without pacing — in us-east-1.
