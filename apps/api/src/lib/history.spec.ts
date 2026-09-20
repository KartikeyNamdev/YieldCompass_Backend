import { dailyLast, withRealized } from "./history";

const pt = (day: number, share: number | null, base: number | null = 0.06) => ({
  ts: new Date(Date.UTC(2026, 0, day, 12)).toISOString(), tvl_usd: 1, apy_headline: 0.08, apy_base: base, apy_reward: 0.02, share_rate: share,
});

describe("history", () => {
  it("keeps the last point of each day", () => {
    const a = { ...pt(1, 1), ts: "2026-01-01T01:00:00.000Z", tvl_usd: 1 };
    const b = { ...pt(1, 1), ts: "2026-01-01T23:00:00.000Z", tvl_usd: 2 };
    expect(dailyLast([a, b, pt(2, 1)]).map((p) => p.tvl_usd)).toEqual([2, 1]);
  });

  it("realized APY comes from the share rate growth over 7 days", () => {
    // 5.9% APY growth per day compounding, share rate known
    const g = Math.pow(1.059, 1 / 365);
    const pts = Array.from({ length: 10 }, (_, i) => pt(i + 1, Math.pow(g, i)));
    const out = withRealized(pts);
    expect(out[9].realized_apy).toBeCloseTo(0.059, 6);
    expect(out[0].realized_apy).toBe(0.06); // no earlier point: falls back to base APY
  });

  it("falls back to base APY without share rates", () => {
    expect(withRealized([pt(1, null, 0.04), pt(9, null, 0.05)]).map((p) => p.realized_apy)).toEqual([0.04, 0.05]);
  });
});
