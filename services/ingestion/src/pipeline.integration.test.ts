/**
 * Runs the real pipeline against Postgres + the analytics service.
 *   TEST_DATABASE_URL=postgres://yc@localhost:5433/yc TEST_ANALYTICS_URL=http://localhost:8000 npm -w @yc/ingestion test
 * Skipped when those variables are not set.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "path";
import { Pool } from "pg";
import { runMigrations } from "@yc/shared";
import { AnalyticsClient } from "./analytics";
import { Deps, analyzeDocs, computeApy, ingestPools } from "./jobs";

const DB = process.env.TEST_DATABASE_URL;
const AN = process.env.TEST_ANALYTICS_URL;

describe.skipIf(!DB || !AN)("ingestion pipeline (demo mode, real DB + analytics)", () => {
  it("ingests, computes APY, scores risk, and enqueues publish jobs only when the score changes", async () => {
    const pool = new Pool({ connectionString: DB });
    await runMigrations(pool, resolve(__dirname, "../../../migrations"));
    await pool.query("TRUNCATE pool_snapshots, realized_apy, risk_scores, protocols CASCADE");

    const enqueued: Array<{ q: string; name: string; data: any; jobId?: string }> = [];
    const mk = (q: string) => async (name: string, data: Record<string, unknown>, opts?: { jobId?: string }) => {
      enqueued.push({ q, name, data, jobId: opts?.jobId });
    };
    const deps: Deps = {
      pool, demo: true, analytics: new AnalyticsClient(AN!), now: () => new Date("2026-09-20T10:00:00Z"),
      seedDir: resolve(__dirname, "../../../data/seed"), liveConfigPath: "",
      enqueue: { computeApy: mk("compute"), analyzeDocs: mk("analyze"), publishRisk: mk("publish") },
    };

    const ing = await ingestPools(deps);
    expect(ing.protocols).toBeGreaterThanOrEqual(5);
    expect(enqueued.map((e) => e.q)).toEqual(["compute", "analyze"]); // first run also schedules analysis

    expect((await computeApy(deps)).computed).toBe(ing.protocols);
    const realized = await pool.query("SELECT apy, basis FROM realized_apy WHERE protocol_id='aurora-lend' AND window_days=30");
    expect(Number(realized.rows[0].apy)).toBeCloseTo(0.059, 4); // hand-checkable: seed was generated at 5.9%
    expect(realized.rows[0].basis).toBe("share_rate");

    const first = await analyzeDocs(deps);
    expect(first.analyzed).toBe(ing.protocols);
    expect(first.changed.length).toBe(ing.protocols); // every score is new
    const risk = await pool.query("SELECT score, explanation, jsonb_array_length(sources) AS n FROM risk_scores WHERE protocol_id='delta-farm'");
    expect(risk.rows[0].score).toBeLessThan(40);
    expect(risk.rows[0].n).toBeGreaterThan(0);

    const before = enqueued.filter((e) => e.q === "publish").length;
    const second = await analyzeDocs(deps);
    expect(second.changed).toEqual([]);
    expect(enqueued.filter((e) => e.q === "publish").length).toBe(before); // unchanged scores are not republished

    // re-ingesting replaces (not duplicates) the re-timed seed
    await ingestPools(deps);
    const n = await pool.query("SELECT count(*)::int AS n FROM pool_snapshots WHERE protocol_id='aurora-lend'");
    expect(n.rows[0].n).toBe(35);
    await pool.end();
  }, 60_000);
});
