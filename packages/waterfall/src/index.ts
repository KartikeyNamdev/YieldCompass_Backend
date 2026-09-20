/**
 * Waterfall math. Mirrors programs/yc_vault/src/math.rs and programs/mock_yield exactly.
 * All values are bigint (u64 semantics). Functions return null where Rust returns None.
 */
export const BPS = 10_000n;
export const SECS_PER_YEAR = 31_536_000n;
export const U64_MAX = (1n << 64n) - 1n;

const fitsU64 = (v: bigint): boolean => v >= 0n && v <= U64_MAX;

/** Principal + simple interest for the term. */
export function seniorOwed(principal: bigint, rateBps: number, termSecs: bigint): bigint | null {
  if (termSecs < 0n || principal < 0n || !fitsU64(principal)) return null;
  const interest = (principal * BigInt(rateBps) * termSecs) / (BPS * SECS_PER_YEAR);
  const total = principal + interest;
  return fitsU64(total) ? total : null;
}

/** [seniorPayout, juniorPayout]. Always sums to totalAssets. */
export function waterfall(totalAssets: bigint, owed: bigint): { senior: bigint; junior: bigint } {
  const senior = totalAssets < owed ? totalAssets : owed;
  return { senior, junior: totalAssets - senior };
}

/** Pro-rata share of a tranche payout. Rounds DOWN. */
export function claimAmount(payoutTotal: bigint, userShares: bigint, totalShares: bigint): bigint | null {
  if (totalShares === 0n) return null;
  const v = (payoutTotal * userShares) / totalShares;
  return fitsU64(v) ? v : null;
}

/** True if the junior buffer is large enough. */
export function juniorRatioOk(senior: bigint, junior: bigint, minJuniorBps: number): boolean {
  const total = senior + junior;
  if (total === 0n) return true;
  return junior * BPS >= total * BigInt(minJuniorBps);
}

/** Mirrors mock_yield simulate_yield / simulate_loss: the move is floor(deployed * |bps| / 10000). */
export function applyYield(deployed: bigint, yieldBps: number): bigint {
  if (!Number.isInteger(yieldBps) || yieldBps < -10_000) throw new RangeError("yieldBps must be an integer >= -10000");
  const move = (deployed * BigInt(Math.abs(yieldBps))) / BPS;
  return yieldBps >= 0 ? deployed + move : deployed - move;
}

export interface SimulateInput {
  seniorPrincipal: bigint;
  juniorPrincipal: bigint;
  rateBps: number;
  termSecs: bigint;
  yieldBps: number;
}

export interface SimulateResult {
  totalAssets: bigint;
  seniorOwed: bigint;
  seniorPayout: bigint;
  juniorPayout: bigint;
  /** true when the senior tranche receives less than its target */
  seniorShortfall: boolean;
}

export function simulate(i: SimulateInput): SimulateResult {
  const owed = seniorOwed(i.seniorPrincipal, i.rateBps, i.termSecs);
  if (owed === null) throw new RangeError("senior owed overflows u64");
  const totalAssets = applyYield(i.seniorPrincipal + i.juniorPrincipal, i.yieldBps);
  const { senior, junior } = waterfall(totalAssets, owed);
  return { totalAssets, seniorOwed: owed, seniorPayout: senior, juniorPayout: junior, seniorShortfall: senior < owed };
}

export const DEFAULT_SCENARIOS_BPS = [-1000, -500, 0, 200, 600] as const;

export function scenarios(base: Omit<SimulateInput, "yieldBps">, yieldBpsList: readonly number[] = DEFAULT_SCENARIOS_BPS) {
  return yieldBpsList.map((yieldBps) => ({ yieldBps, ...simulate({ ...base, yieldBps }) }));
}
