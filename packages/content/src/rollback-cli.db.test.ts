/**
 * `ksor rollback` — the CLI, end to end against a real database (gated on
 * KSOR_DB_URL; CI provides the pgvector service). The rollback PRIMITIVE's
 * pointer restore + CHECK-allowed audit row are proven in
 * ingest/ingest.db.test.ts (7); this proves the CLI SURFACE the deployment's
 * emergency rollback drives:
 *
 *   - it REFUSES (exit 1, slug `ksor-rollback-empty`) when no prior generation
 *     is recorded — the corpus has been flipped once, so rollback_generation
 *     is still 0;
 *   - after a SECOND flip it restores the prior generation, NAMES it and its
 *     embedding model on stdout (so the operator points the runtime at the
 *     matching image — a mismatch must fail closed), and
 *   - the audit trail survives (the rollback rides the CHECK-allowed
 *     `generation_activated` action with `rolled_back: true`).
 *
 * The CLI reads ./instance.md for identity (tenant = corpus = its `name`) and
 * the DSN from the env var it names, so the committed demo-rulebook fixture is
 * both what we ingest into and the --instance the CLI parses; KSOR_DB_URL is
 * pointed at the scratch database for the duration.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runContentCli } from "./commands.js";
import { contentPool } from "./db.js";
import { applySchema } from "./schema.js";
import { buildGeneration } from "./ingest/build.js";
import { buildShippedProvider } from "./lib/providers/registry.js";
import { FAKE_EMBED_MODEL } from "./lib/providers/fake.js";
import { instanceOf as fixtureInstance } from "./ingest/fixtures/record-fixture.js";

const adminDsn = process.env["KSOR_DB_URL"] ?? "";
const DIM = 8;
// The committed profile-shaped fixture: its instance.md names `demo-rulebook`,
// so the CLI derives tenant = corpus = "demo-rulebook" and dsn_env = KSOR_DB_URL.
const FIXTURE = fileURLToPath(new URL("./ingest/fixtures/record/demo-rulebook", import.meta.url));
const NAME = "demo-rulebook";
const INSTANCE_PATH = join(FIXTURE, "instance.md");

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

describe.runIf(adminDsn !== "")("ksor rollback — CLI db acceptance", () => {
  const instance = fixtureInstance(NAME, NAME, {
    embeddingModel: FAKE_EMBED_MODEL,
    embeddingDim: DIM,
  });
  const fake = buildShippedProvider("fake", { apiKey: null, dim: DIM });

  let admin: pg.Pool;
  let pool: pg.Pool;
  let dbName: string;
  let savedDsn: string | undefined;

  beforeAll(async () => {
    dbName = `ksor_rb_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    admin = new pg.Pool({ connectionString: adminDsn, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminDsn);
    url.pathname = `/${dbName}`;
    pool = contentPool(url.toString(), 4);
    await applySchema(pool, DIM);
    await pool.query(
      "INSERT INTO ingest_tenant_grants (role_name, tenant_id) VALUES ('sor_content_ingest', $1)",
      [NAME],
    );
    // The CLI opens its OWN pool from the DSN env the instance names; point it
    // at the scratch database for the duration (admin uses the captured DSN).
    savedDsn = process.env["KSOR_DB_URL"];
    process.env["KSOR_DB_URL"] = url.toString();
  }, 120_000);

  afterAll(async () => {
    if (savedDsn === undefined) delete process.env["KSOR_DB_URL"];
    else process.env["KSOR_DB_URL"] = savedDsn;
    await pool?.end();
    if (admin !== undefined) {
      if (dbName !== undefined)
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
    vi.restoreAllMocks();
  }, 60_000);

  it("refuses with exit 1 and slug ksor-rollback-empty after a single flip", async () => {
    const g1 = await buildGeneration(pool, instance, {
      recordRoot: FIXTURE,
      sourceCommit: "commit-1",
      flip: true,
      provider: fake,
    });
    expect(g1.generation).toBe(1);

    const cap = capture();
    const code = await runContentCli(["rollback", "--instance", INSTANCE_PATH]);
    vi.restoreAllMocks();
    expect(code, cap.err.join("")).toBe(1);
    expect(cap.err.join("")).toContain("error: ksor-rollback-empty");
    // The active pointer is untouched by a refused rollback.
    const p = await pool.query(
      "SELECT active_generation FROM corpora WHERE tenant_id = $1 AND corpus_id = $1",
      [NAME],
    );
    expect(Number(p.rows[0].active_generation)).toBe(1);
  }, 120_000);

  it("restores the prior generation, naming it and its embedding model, audit preserved", async () => {
    // A new commit over identical bytes earns generation 2 (ingest.db.test (2)).
    const g2 = await buildGeneration(pool, instance, {
      recordRoot: FIXTURE,
      sourceCommit: "commit-2",
      flip: true,
      provider: fake,
    });
    expect(g2.generation).toBe(2);

    const cap = capture();
    const code = await runContentCli(["rollback", "--instance", INSTANCE_PATH]);
    vi.restoreAllMocks();
    const stdout = cap.out.join("");
    expect(code, cap.err.join("")).toBe(0);
    // Output NAMES the restored generation and its embedding model — the value
    // the operator matches the runtime image against.
    expect(stdout).toContain("restored generation 1");
    expect(stdout).toContain(FAKE_EMBED_MODEL);

    // The pointer moved back to 1.
    const p = await pool.query(
      "SELECT active_generation FROM corpora WHERE tenant_id = $1 AND corpus_id = $1",
      [NAME],
    );
    expect(Number(p.rows[0].active_generation)).toBe(1);

    // The audit row survives: the rollback rides the CHECK-allowed action with
    // the rolled_back flag (never a new action that would abort the txn).
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM retrieval_log WHERE tenant_id = $1" +
        " AND action = 'generation_activated' AND detail->>'rolled_back' = 'true'",
      [NAME],
    );
    expect(audit.rows[0].n).toBe(1);
  }, 120_000);
});
