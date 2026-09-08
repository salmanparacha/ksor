---
"@panaversity/ksor": patch
---

Log the reason an MCP/health bearer token is rejected — safely. The gateway's
`/mcp` and `/health` auth-verify catch blocks previously returned a generic
"invalid token" (401) and logged nothing, so an operator could not tell an
audience mismatch from a JWKS-fetch failure from a bad issuer. A new
`authRejectionLine` helper now emits a one-line diagnostic:

- detailed context ONLY for a `TokenVerifyError` (whose message is ours and
  carries safe context such as "aud X not in allowlist Y", never the token);
- for ANY other thrown value, a fixed category "unexpected verifier error" and
  nothing from the value itself;
- the known message is stripped of CR/LF (no log-forging) and length-bounded.

Response bodies and 401/503 status mapping are unchanged. Tests prove a
sentinel bearer value never reaches `console.error` on either surface.
