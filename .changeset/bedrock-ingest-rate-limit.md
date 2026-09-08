---
"@panaversity/ksor": patch
---

fix(bedrock): pace ingest embeds under the per-minute InvokeModel cap

Titan V2's on-demand cap is 60 requests/min and is NOT adjustable, so a fresh
ingest — one InvokeModel per chunk, fired as fast as `fetch` allows — bursts
past it and Bedrock returns 429; the drain's retry cannot clear a sustained
throttle and refuses (`ksor-refused`).

The Bedrock transport now takes an injectable `pace` hook awaited once before
each InvokeModel request, and a shared process-wide token-bucket pacer
(`ingestPacer`, read from `KSOR_BEDROCK_MAX_RPM`, default 50 — a margin under
60; set 0 to disable for provisioned throughput). Because the cap is
per-account, the bucket is shared across vendors. Pacing is passed PER EMBED
CALL and scoped to `intent: "document"` only — a `query` embed NEVER enters the
pacer, so a throttled read still degrades to keyword-only promptly instead of
joining the ingest queue. Pacing happens before the signature timestamp is
fixed, so a paced wait never drifts the SigV4 signature.

Verified by a deterministic token-bucket test, a pace-hook ordering test,
intent-scoping tests (document paced, query never paced, query degrades
promptly under throttling), and a gated live proof: a burst of 70 Titan
document embeds (above the 60/min cap) completing with zero 429s, and a
query-intent embed returning promptly without pacing — in us-east-1.
