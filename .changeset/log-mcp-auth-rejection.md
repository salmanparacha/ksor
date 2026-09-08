---
"@panaversity/ksor": patch
---

Log the reason an MCP/health bearer token is rejected. The gateway's `/mcp`
and `/health` auth-verify catch blocks previously returned a generic
"invalid token" (401) and logged nothing, so an operator could not tell an
audience mismatch from a JWKS-fetch failure from a bad issuer — the door was
silent on why. Both catch blocks now `console.error` the caught error's name
and message (which carry safe context such as "aud X not in allowlist Y" and
never the raw token). "Errors are documentation" applied to the auth seam.
