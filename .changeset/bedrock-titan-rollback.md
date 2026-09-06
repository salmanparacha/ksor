---
"@panaversity/ksor": patch
---

Add Amazon Bedrock Titan Text Embeddings V2 as a keyless embedding provider, a
generic Bedrock SigV4 transport shared by the Titan and Cohere serializers, and
the `ksor rollback` verb.

- **`bedrock-titan` provider** (`amazon.titan-embed-text-v2:0`, 1024-dim,
  normalized, symmetric, keyless SigV4/IAM): the production embedding model for
  the HealthLake deployment. One `inputText` per `InvokeModel`, order preserved;
  an input over Titan's 50,000-character ceiling is REFUSED
  (`ksor-titan-input-too-large`), never truncated, and a token overage surfaces
  the vendor 400 — a silently cut embedding is a silently wrong vector.
- **Generic `bedrock-rest.ts` transport**: model-neutral SigV4 signing (with an
  injectable clock, so signing is deterministically testable), the
  `InvokeModel` POST, the HTTP error type and the plane-aware retry classifier.
  The Cohere adapter now composes it and is retained as the emergency ROLLBACK
  target; no signed request changed shape.
- **`ksor rollback --instance PATH`**: restores the generation active before the
  last flip, reusing the existing transactional primitive (advisory lock,
  pointer rules, CHECK-allowed audit row). Refuses when no prior generation
  exists (`ksor-rollback-empty`) and prints the restored generation and its
  embedding model so the runtime image can be matched — a provider/model
  mismatch must fail closed.
