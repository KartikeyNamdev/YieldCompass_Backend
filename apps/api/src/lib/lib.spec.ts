import { BadRequestException } from "@nestjs/common";
import { PoolSummary, rankPools } from "./ranking";
import { buildQuote, buildSimulation, SeriesFacts } from "./quote";
import { fromBaseUnits, toBaseUnits } from "./units";

const pool = (o: Partial<PoolSummary> & { id: string }): PoolSummary => ({
  name: o.id, category: "lending", chain: "solana", data_source: "seed-synthetic", headline_apy: 0.08, realized_apy_7d: 0.05,
  realized_apy_30d: 0.05, realized_basis: "share_rate", emissions_share: 0.1, mostly_bonus_tokens: false,
  gap: { advertised: 0.08, realized: 0.05, gap_points: 0.03 }, tvl_usd: 1e8, risk_score: 80, sustainable_realized_apy: 0.05,
  risk_adjusted_yield: 0.04, updated_at: "2026-01-01T00:00:00.000Z", ...o,
});

describe("rankPools", () => {
  const safe = pool({ id: "safe", risk_score: 90, sustainable_realized_apy: 0.05 });
  const mid = pool({ id: "mid", risk_score: 70, sustainable_realized_apy: 0.07 });
  const degen = pool({ id: "degen", risk_score: 28, sustainable_realized_apy: 0.23, emissions_share: 0.92, mostly_bonus_tokens: true, headline_apy: 0.38 });
  const unscored = pool({ id: "unscored", risk_score: null, sustainable_realized_apy: null });
  const all = [degen, safe, unscored, mid];

  it("conservative excludes low-score, bonus-token and unscored pools, with reasons", () => {
    const { included, excluded } = rankPools(all, "conservative", "risk_adjusted");
    expect(included.map((p) => p.id)).toEqual(["safe", "mid"]);
    expect(excluded.map((e) => e.id).sort()).toEqual(["degen", "unscored"]);
    expect(excluded.find((e) => e.id === "degen")!.reason).toMatch(/below the conservative minimum/);
  });

  it("the profile changes the ranking, not just the filter", () => {
    // conservative weights risk twice: safe 0.05*.81=.0405 vs mid 0.07*.49=.0343
    expect(rankPools(all, "conservative", "risk_adjusted").included[0].id).toBe("safe");
    // balanced: safe 0.05*.9=.045 vs mid 0.07*.7=.049
    expect(rankPools(all, "balanced", "risk_adjusted").included[0].id).toBe("mid");
    // aggressive keeps degen: 0.23*sqrt(.28)=.1217 beats both
    expect(rankPools(all, "aggressive", "risk_adjusted").included[0].id).toBe("degen");
  });

  it("headline sort puts the bonus-token pool first: exactly what realized ranking corrects", () => {
    expect(rankPools(all, "aggressive", "headline").included[0].id).toBe("degen");
    expect(rankPools(all, "balanced", "risk_adjusted").included[0].id).not.toBe("degen");
  });

  it("nulls sort last and ties are deterministic", () => {
    const a = pool({ id: "b", risk_score: 80, sustainable_realized_apy: 0.05 });
    const b = pool({ id: "a", risk_score: 80, sustainable_realized_apy: 0.05 });
    expect(rankPools([a, b], "balanced", "risk_adjusted").included.map((p) => p.id)).toEqual(["a", "b"]);
    const noApy = pool({ id: "z", risk_score: 80, sustainable_realized_apy: null });
    expect(rankPools([noApy, a], "balanced", "risk_adjusted").included.map((p) => p.id)).toEqual(["b", "z"]);
  });
});

describe("units", () => {
  it("round trips", () => {
    expect(toBaseUnits("100", 6)).toBe(100_000_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(fromBaseUnits(102_500_000n, 6)).toBe("102.5");
    expect(fromBaseUnits(1n, 6)).toBe("0.000001");
    expect(fromBaseUnits(0n, 6)).toBe("0");
  });
  it.each(["", "abc", "-1", "0", "0.0", "1.1234567", "1e6", "99999999999999999999"])("rejects %j", (bad) => {
    expect(() => toBaseUnits(bad, 6)).toThrow(BadRequestException);
  });
});

const D = 1_000_000n;
const series = (o: Partial<SeriesFacts> = {}): SeriesFacts => ({
  id: "1", status: "open", rate_bps: 200, term_secs: 31_536_000, decimals: 6, senior_principal: 100n * D, junior_principal: 10n * D,
  min_junior_bps: 1000, deposit_deadline: new Date(Date.now() + 3600_000), maturity_ts: null, ...o,
});

describe("simulate (scenario slider)", () => {
  it("reproduces the Section 4.3 table", () => {
    const rows: Array<[number, string, string]> = [[600, "102", "14.6"], [200, "102", "10.2"], [0, "102", "8"], [-500, "102", "2.5"], [-1000, "99", "0"]];
    for (const [bps, senior, junior] of rows) {
      const r = buildSimulation(series(), bps);
      expect([r.senior_payout, r.junior_payout]).toEqual([senior, junior]);
    }
  });
  it("flags senior shortfall only after junior is wiped out", () => {
    expect(buildSimulation(series(), -500)).toMatchObject({ senior_shortfall: false, junior_wiped_out: false });
    expect(buildSimulation(series(), -1000)).toMatchObject({ senior_shortfall: true, junior_wiped_out: true });
  });
});

describe("quote (term sheet)", () => {
  it("senior: 100 becomes a 102 TARGET on the estimated maturity date", () => {
    const s = series({ senior_principal: 0n, junior_principal: 100n * D });
    const q = buildQuote(s, "senior", 100n * D);
    expect(q.target_payout).toBe("102");
    expect(q.maturity_is_estimate).toBe(true);
    expect(q.term_sheet).toMatch(/Deposit 100\. Target 102 on \d{4}-\d{2}-\d{2}/);
    expect(q.term_sheet).toContain("not guaranteed");
    expect(q.scenarios.map((x) => x.yield_bps)).toEqual([-1000, -500, 0, 200, 600]);
  });
  it("a depositor's scenario payout is their pro-rata share of the tranche payout", () => {
    // senior 100 existing + 100 new, junior 40: at +0% total 240, senior owed 204 -> new depositor gets half of 204
    const q = buildQuote(series({ senior_principal: 100n * D, junior_principal: 40n * D }), "senior", 100n * D);
    expect(q.scenarios.find((x) => x.yield_bps === 0)!.payout).toBe("102");
    expect(q.scenarios.find((x) => x.yield_bps === -1000)!.loss).toBe("0"); // -10% of 240 = 216 > 204: senior is still fully paid
  });
  it("capacity: reports when a senior deposit would break the buffer and how much room is left", () => {
    const s = series({ senior_principal: 80n * D, junior_principal: 10n * D });
    expect(buildQuote(s, "senior", 10n * D).capacity).toMatchObject({ ok: true, max_additional_senior: "10" });
    expect(buildQuote(s, "senior", 11n * D).capacity.ok).toBe(false);
    expect(buildQuote(s, "junior", 1n * D).capacity.ok).toBe(true);
  });
  it("junior term sheet describes first-loss, never a fixed target", () => {
    const q = buildQuote(series(), "junior", 10n * D);
    expect(q.target_payout).toBeNull();
    expect(q.term_sheet).toMatch(/first-loss/);
  });
  it("uses the real maturity once active", () => {
    const m = new Date("2030-01-02T00:00:00Z");
    const q = buildQuote(series({ status: "active", maturity_ts: m }), "senior", 10n * D);
    expect(q.maturity).toBe(m.toISOString());
    expect(q.maturity_is_estimate).toBe(false);
    expect(q.open_for_deposits).toBe(false);
  });
});
