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
60; set 0 to disable for provisioned throughput) is wired into both the Titan
and Cohere ingest clients. Because the cap is per-account, the bucket is shared
across vendors and calls. Pacing happens before the signature timestamp is
fixed, so a paced wait never drifts the SigV4 signature.

Verified by a deterministic token-bucket test, a pace-hook ordering test, and a
gated live burst of 70 Titan embeds (above the 60/min cap) completing with zero
429s in us-east-1.
