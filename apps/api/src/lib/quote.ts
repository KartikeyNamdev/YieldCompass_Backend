import { DEFAULT_SCENARIOS_BPS, claimAmount, juniorRatioOk, seniorOwed, simulate } from "@yc/waterfall";
import { fromBaseUnits } from "./units";

export interface SeriesFacts {
  id: string;
  status: string;
  rate_bps: number;
  term_secs: number;
  decimals: number;
  senior_principal: bigint;
  junior_principal: bigint;
  min_junior_bps: number;
  deposit_deadline: Date | null;
  maturity_ts: Date | null;
}

export type Tranche = "senior" | "junior";

/** Everything a term sheet shows. Uses the same waterfall math as the on-chain program. */
export function buildQuote(s: SeriesFacts, tranche: Tranche, amount: bigint, yieldBps: readonly number[] = DEFAULT_SCENARIOS_BPS) {
  const seniorAfter = s.senior_principal + (tranche === "senior" ? amount : 0n);
  const juniorAfter = s.junior_principal + (tranche === "junior" ? amount : 0n);
  const trancheAfter = tranche === "senior" ? seniorAfter : juniorAfter;
  const term = BigInt(s.term_secs);
  const fmt = (v: bigint) => fromBaseUnits(v, s.decimals);

  const target = tranche === "senior" ? seniorOwed(amount, s.rate_bps, term) : null;
  const scenarios = yieldBps.map((y) => {
    const r = simulate({ seniorPrincipal: seniorAfter, juniorPrincipal: juniorAfter, rateBps: s.rate_bps, termSecs: term, yieldBps: y });
    const tranchePayout = tranche === "senior" ? r.seniorPayout : r.juniorPayout;
    const mine = claimAmount(tranchePayout, amount, trancheAfter) ?? 0n;
    return { yield_bps: y, payout: fmt(mine), profit: fmt(mine >= amount ? mine - amount : 0n), loss: fmt(mine < amount ? amount - mine : 0n) };
  });

  const maturity = s.maturity_ts ?? (s.deposit_deadline ? new Date(s.deposit_deadline.getTime() + s.term_secs * 1000) : null);
  const open = s.status === "open" && (!s.deposit_deadline || s.deposit_deadline.getTime() > Date.now());
  const capacityOk = tranche === "junior" || juniorRatioOk(seniorAfter, juniorAfter, s.min_junior_bps);
  // largest extra senior deposit the buffer allows: senior <= junior * (10000 - min) / min
  const maxSenior = (s.junior_principal * BigInt(10_000 - s.min_junior_bps)) / BigInt(s.min_junior_bps);
  const headroom = maxSenior > s.senior_principal ? maxSenior - s.senior_principal : 0n;

  const date = maturity ? maturity.toISOString().slice(0, 10) : "the maturity date";
  const term_sheet =
    tranche === "senior"
      ? `Deposit ${fmt(amount)}. Target ${fmt(target ?? 0n)} on ${date} (${maturity && s.maturity_ts ? "maturity" : "estimated maturity"}). Target rate, not guaranteed.`
      : `Deposit ${fmt(amount)} as first-loss capital. Payout is variable: it absorbs losses first and keeps profit above the senior target. Not guaranteed.`;

  return {
    series_id: s.id,
    tranche,
    amount: fmt(amount),
    decimals: s.decimals,
    open_for_deposits: open,
    target_rate_bps: tranche === "senior" ? s.rate_bps : null,
    target_payout: target === null ? null : fmt(target),
    maturity: maturity ? maturity.toISOString() : null,
    maturity_is_estimate: !s.maturity_ts,
    scenarios,
    capacity: { ok: capacityOk, min_junior_bps: s.min_junior_bps, max_additional_senior: fmt(headroom) },
    term_sheet,
  };
}

export function buildSimulation(s: SeriesFacts, yieldBps: number) {
  const r = simulate({
    seniorPrincipal: s.senior_principal, juniorPrincipal: s.junior_principal, rateBps: s.rate_bps, termSecs: BigInt(s.term_secs), yieldBps,
  });
  const fmt = (v: bigint) => fromBaseUnits(v, s.decimals);
  return {
    series_id: s.id,
    yield_bps: yieldBps,
    senior_principal: fmt(s.senior_principal),
    junior_principal: fmt(s.junior_principal),
    total_assets: fmt(r.totalAssets),
    senior_owed: fmt(r.seniorOwed),
    senior_payout: fmt(r.seniorPayout),
    junior_payout: fmt(r.juniorPayout),
    senior_shortfall: r.seniorShortfall,
    junior_wiped_out: r.juniorPayout === 0n && s.junior_principal > 0n,
  };
}
