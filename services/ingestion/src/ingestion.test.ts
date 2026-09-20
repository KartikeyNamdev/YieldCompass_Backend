import { describe, expect, it, vi } from "vitest";
import { resolve } from "path";
import { AnalyticsClient, HttpError } from "./analytics";
import { snapshotFromPool, snapshotsFromChart } from "./defillama";
import { loadSeed } from "./seed";
import { toAnalyzeBody } from "./jobs";

const SEED = resolve(__dirname, "../../../data/seed");

describe("seed loader", () => {
  const now = new Date("2026-09-20T10:37:12Z");
  const seed = loadSeed(SEED, now);

  it("loads at least 5 protocols, all flagged synthetic", () => {
    expect(seed.protocols.length).toBeGreaterThanOrEqual(5);
    expect(seed.protocols.every((p) => p.synthetic)).toBe(true);
  });

  it("re-times so the newest point is the current hour and history spans 34 days", () => {
    const rows = seed.snapshots.filter((s) => s.protocol_id === "aurora-lend");
    const times = rows.map((r) => r.ts.getTime());
    expect(new Date(Math.max(...times)).toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect((Math.max(...times) - Math.min(...times)) / 86_400_000).toBe(34);
  });

  it("is idempotent within the same hour", () => {
    const again = loadSeed(SEED, new Date("2026-09-20T10:59:59Z"));
    expect(again.snapshots[0].ts.toISOString()).toBe(seed.snapshots[0].ts.toISOString());
  });

  it("derives launch date from fixed age so risk scores do not drift with the clock", () => {
    const later = loadSeed(SEED, new Date("2027-03-01T00:00:00Z"));
    const age = (s: typeof seed, anchor: string, id: string) =>
      (new Date(anchor).getTime() - new Date(s.protocols.find((p) => p.id === id)!.launched!).getTime()) / 86_400_000;
    expect(age(seed, "2026-09-20T10:00:00Z", "delta-farm")).toBeCloseTo(age(later, "2027-03-01T00:00:00Z", "delta-farm"), 0);
  });
});

describe("DefiLlama mapping", () => {
  it("converts percent to decimal fractions and never invents a share rate", () => {
    const s = snapshotFromPool("x", { pool: "p", tvlUsd: 1e6, apy: 4.9, apyBase: 4.5, apyReward: 0.4 }, new Date(0));
    expect(s.apy_headline).toBeCloseTo(0.049);
    expect(s.apy_base).toBeCloseTo(0.045);
    expect(s.apy_reward).toBeCloseTo(0.004);
    expect(s.share_rate).toBeNull();
  });

  it("treats a missing reward APY as zero and keeps a null base", () => {
    const rows = snapshotsFromChart("x", [{ timestamp: "2026-01-01T00:00:00Z", tvlUsd: 5, apy: 3, apyBase: null, apyReward: null }]);
    expect(rows[0].apy_reward).toBe(0);
    expect(rows[0].apy_base).toBeNull();
  });
});

describe("AnalyticsClient", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("retries 5xx with backoff and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 503 })).mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok({ a: 1 }));
    const c = new AnalyticsClient("http://x", f as unknown as typeof fetch, { baseDelayMs: 1 });
    expect(await c.post("/p", {})).toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const f = vi.fn().mockResolvedValue(new Response("bad", { status: 422 }));
    const c = new AnalyticsClient("http://x", f as unknown as typeof fetch, { baseDelayMs: 1 });
    await expect(c.post("/p", {})).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const f = vi.fn().mockResolvedValue(new Response("down", { status: 500 }));
    const c = new AnalyticsClient("http://x", f as unknown as typeof fetch, { retries: 2, baseDelayMs: 1 });
    await expect(c.post("/p", {})).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("toAnalyzeBody", () => {
  it("serialises timestamps as ISO strings and only includes extraction when present", () => {
    const seed = loadSeed(SEED, new Date());
    const p = seed.protocols[0];
    const snaps = seed.snapshots.filter((s) => s.protocol_id === p.id);
    const body = toAnalyzeBody(p, snaps);
    expect(typeof body.snapshots[0].ts).toBe("string");
    expect("extraction" in body).toBe(false);
    expect("extraction" in toAnalyzeBody(p, snaps, { protocol_id: p.id })).toBe(true);
  });
});
