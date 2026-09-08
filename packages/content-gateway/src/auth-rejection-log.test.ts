// auth-rejection-log.test.ts — the auth-verify rejection log must NEVER leak a
// secret. Detailed context is emitted ONLY for our own TokenVerifyError (whose
// message carries no token); any other thrown value logs a fixed category and
// nothing from the value. Both /mcp and /health use the same helper.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { TokenVerifyError } from "@panaversity/ksor-gateway-kit";
import { authRejectionLine } from "./http.js";

// A value that must NEVER appear in a log line: stand-in for a raw bearer token
// or any attacker-influenced content in an unexpected error.
const SENTINEL = "SECRET-BEARER-eyJhbGciOi.DO-NOT-LOG.zzz";

for (const surface of ["mcp", "health"] as const) {
  describe(`authRejectionLine — ${surface}`, () => {
    test("an UNKNOWN error logs only the fixed category — never the value", () => {
      const line = authRejectionLine(surface, new Error(SENTINEL));
      assert.equal(line, `${surface} auth rejected (401): unexpected verifier error`);
      assert.ok(!line.includes(SENTINEL), "sentinel must not reach the log");
    });

    test("a thrown non-Error string never reaches the log", () => {
      const line = authRejectionLine(surface, SENTINEL);
      assert.ok(!line.includes(SENTINEL), "raw thrown string must not be logged");
      assert.ok(line.endsWith("unexpected verifier error"));
    });

    test("a TokenVerifyError message IS logged (it is ours, no secret)", () => {
      const line = authRejectionLine(
        surface,
        new TokenVerifyError("aud X not in allowlist Y", { transient: false }),
      );
      assert.ok(line.includes("aud X not in allowlist Y"));
      assert.ok(line.startsWith(`${surface} auth rejected (401): `));
    });

    test("a transient TokenVerifyError is tagged 503", () => {
      const line = authRejectionLine(
        surface,
        new TokenVerifyError("jwks unreachable", { transient: true }),
      );
      assert.ok(line.startsWith(`${surface} auth rejected (503 transient): `));
    });

    test("known diagnostic is CR/LF-sanitized (no log forging)", () => {
      const line = authRejectionLine(
        surface,
        new TokenVerifyError("line1\r\ninjected: forged\nmore", { transient: false }),
      );
      assert.ok(!/[\r\n]/.test(line), "no raw CR/LF may survive into the log line");
    });

    test("known diagnostic is length-bounded", () => {
      const line = authRejectionLine(
        surface,
        new TokenVerifyError("x".repeat(5000), { transient: false }),
      );
      assert.ok(line.length < 300, `line length ${line.length} must be bounded`);
    });
  });
}

describe("authRejectionLine — unknown subclasses", () => {
  test("a sentinel inside an unknown Error subclass is still not logged", () => {
    class Weird extends Error {}
    const line = authRejectionLine("mcp", new Weird(SENTINEL));
    assert.ok(!line.includes(SENTINEL));
    assert.equal(line, "mcp auth rejected (401): unexpected verifier error");
  });
});
