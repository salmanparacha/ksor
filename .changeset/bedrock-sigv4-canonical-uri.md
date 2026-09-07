---
"@panaversity/ksor": patch
---

fix(bedrock): SigV4 canonical URI must be double-encoded for reserved-char model IDs

The Bedrock REST signer used one string for both the wire URL and the SigV4
canonical URI. For a model ID containing a reserved char — `amazon.titan-embed-text-v2:0`
has a `:` — the two forms differ: the wire path single-encodes the segment
(`:` → `%3A`) while the SigV4 canonical URI must encode it again (`%3A` → `%253A`),
per the AWS rule for every service except S3. Signing the single-encoded path
made Bedrock reject every Titan `InvokeModel` with `403 SignatureDoesNotMatch`.

The signer now derives the wire URI (single-encoded, preserving `/` separators)
and the canonical URI (double-encoded) separately via an AWS-compatible
per-segment encoder. Cohere and reserved-char-free model IDs are unaffected
(the encoder is a no-op on them). Covered by a regression test, an updated
independent known-answer signature, and a gated live Titan `InvokeModel` smoke
test in us-east-1.
