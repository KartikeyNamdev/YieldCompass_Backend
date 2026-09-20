import { describe, expect, it } from "vitest";
import { claimAmount, juniorRatioOk, seniorOwed, simulate, waterfall, U64_MAX } from "./index";

const D = 1_000_000n; // 6 decimals
const YEAR = 31_536_000n;

describe("Section 4.3 table (senior 100, junior 10, 2%, 1y)", () => {
  const rows: Array<[number, bigint, bigint, bigint]> = [
    [600, 11_660n, 10_200n, 1_460n],
    [200, 11_220n, 10_200n, 1_020n],
    [0, 11_000n, 10_200n, 800n],
    [-500, 10_450n, 10_200n, 250n],
    [-1000, 9_900n, 9_900n, 0n],
  ];
  for (const [bps, total, senior, junior] of rows) {
    it(`${bps} bps`, () => {
      const r = simulate({ seniorPrincipal: 100n * D, juniorPrincipal: 10n * D, rateBps: 200, termSecs: YEAR, yieldBps: bps });
      expect(r.totalAssets).toBe((total * D) / 100n);
      expect(r.seniorPayout).toBe((senior * D) / 100n);
      expect(r.juniorPayout).toBe((junior * D) / 100n);
    });
  }
});

describe("primitives", () => {
  it("senior owed", () => {
    expect(seniorOwed(100n * D, 200, YEAR)).toBe(102n * D);
    expect(seniorOwed(1n, 200, -1n)).toBeNull();
    expect(seniorOwed(U64_MAX, 5000, YEAR)).toBeNull();
  });
  it("claim rounds down", () => {
    expect(claimAmount(100n, 1n, 3n)).toBe(33n);
    expect(claimAmount(100n, 1n, 0n)).toBeNull();
  });
  it("capacity rule", () => {
    expect(juniorRatioOk(90n, 10n, 1000)).toBe(true);
    expect(juniorRatioOk(91n, 10n, 1000)).toBe(false);
    expect(juniorRatioOk(0n, 0n, 1000)).toBe(true);
  });
  it("waterfall conserves assets (randomized invariants 1 and 2)", () => {
    let seed = 12345n;
    const rnd = () => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) & U64_MAX), seed >> 20n);
    for (let n = 0; n < 2000; n++) {
      const assets = rnd();
      const owed = rnd();
      const { senior, junior } = waterfall(assets, owed);
      expect(senior + junior).toBe(assets);
      expect(senior <= owed).toBe(true);
    }
  });
  it("claims never exceed payout (invariant 4)", () => {
    const shares = [7n, 13n, 29n, 1n];
    const total = shares.reduce((a, b) => a + b, 0n);
    const paid = shares.reduce((a, s) => a + claimAmount(1_000_003n, s, total)!, 0n);
    expect(paid <= 1_000_003n).toBe(true);
  });
});
