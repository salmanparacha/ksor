/**
 * The `ksor rollback` CLI SURFACE, without a database: the verb is dispatched,
 * its usage block is reachable, and the shared instance/DSN guard rails refuse
 * the same way every other write-plane verb does. The pointer-restore, audit
 * preservation and embedding-model output are DB-tier behavior and live in
 * rollback-cli.db.test.ts (and the primitive itself in ingest.db.test.ts (7)).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { runContentCli, usageFor } from "./commands.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("ksor rollback — usage", () => {
  it("has its own usage block naming the backward-restore and the model-match caveat", () => {
    const block = usageFor("rollback");
    expect(block).toContain("ksor rollback");
    expect(block).toContain("active BEFORE the last flip");
    expect(block).toContain("embedding model");
    expect(block).toContain("fail closed");
    // A verb's block must not bleed into the next verb's, nor be the whole usage.
    expect(block).not.toContain("ksor gc --instance");
  });

  it("`ksor rollback --help` prints the block and exits 0", async () => {
    const cap = capture();
    const code = await runContentCli(["rollback", "--help"]);
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain("ksor rollback");
  });
});

describe("ksor rollback — arg guard rails (no database touched)", () => {
  it("refuses with bad-args and exit 1 when --instance is missing", async () => {
    const cap = capture();
    const code = await runContentCli(["rollback"]);
    expect(code).toBe(1);
    // First stderr line is the stable slug (product principle 4).
    expect(cap.err.join("")).toContain("error: bad-args");
    expect(cap.err.join("")).toContain("--instance");
  });
});
