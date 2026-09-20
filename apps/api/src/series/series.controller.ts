import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { seniorOwed } from "@yc/waterfall";
import { DISCLAIMER } from "@yc/shared/dist/constants";
import { CacheService } from "../infra/cache.service";
import { buildQuote, buildSimulation } from "../lib/quote";
import { SeriesIdPipe } from "../lib/pipes";
import { fromBaseUnits, toBaseUnits } from "../lib/units";
import { QuoteQuery, SimulateBody } from "./series.dto";
import { SeriesRepo, SeriesRow } from "./series.repo";

const SERIES_TTL = 10;

export function presentSeries(s: SeriesRow, now = Date.now()) {
  const fmt = (v: bigint) => fromBaseUnits(v, s.decimals);
  const owed = seniorOwed(s.senior_principal, s.rate_bps, BigInt(s.term_secs));
  const totalIn = s.senior_principal + s.junior_principal;
  const settled = s.status === "settled" && totalIn > 0n;
  const periodReturn = settled ? Number(s.senior_payout + s.junior_payout - totalIn) / Number(totalIn) : null;
  // largest senior tranche the current junior buffer supports: junior * (10000 - min) / min
  const seniorCapacity = (s.junior_principal * BigInt(10_000 - s.min_junior_bps)) / BigInt(s.min_junior_bps);
  // junior needed to back the current senior tranche
  const juniorNeeded = (s.senior_principal * BigInt(s.min_junior_bps)) / BigInt(10_000 - s.min_junior_bps);
  return {
    id: s.id,
    pubkey: s.pubkey,
    status: s.status,
    rate_bps: s.rate_bps,
    term_secs: s.term_secs,
    decimals: s.decimals,
    deposit_deadline: s.deposit_deadline?.toISOString() ?? null,
    start_ts: s.start_ts?.toISOString() ?? null,
    maturity_ts: s.maturity_ts?.toISOString() ?? null,
    seconds_to_maturity: s.maturity_ts ? Math.max(0, Math.round((s.maturity_ts.getTime() - now) / 1000)) : null,
    senior_principal: fmt(s.senior_principal),
    junior_principal: fmt(s.junior_principal),
    senior_target: owed === null ? null : fmt(owed),
    senior_payout: s.status === "settled" ? fmt(s.senior_payout) : null,
    junior_payout: s.status === "settled" ? fmt(s.junior_payout) : null,
    min_junior_bps: s.min_junior_bps,
    min_risk_score: s.min_risk_score,
    senior_capacity: fmt(seniorCapacity),
    junior_needed: fmt(juniorNeeded),
    protocol_id: s.protocol_id,
    risk_score: s.risk_score,
    risk_expires_at: s.risk_expires_at?.toISOString() ?? null,
    // period return of the whole series; annualised only when the term is at least a week
    realized_period_return: periodReturn,
    realized_apy: periodReturn !== null && s.term_secs >= 7 * 86_400 ? Math.pow(1 + periodReturn, (365 * 86_400) / s.term_secs) - 1 : null,
    settled_at: settled ? s.updated_at.toISOString() : null,
    created_at: s.created_at.toISOString(),
    addresses: {
      underlying_mint: s.underlying_mint, senior_mint: s.senior_mint, junior_mint: s.junior_mint,
      vault: s.vault, strategy_pool: s.strategy_pool, risk_entry: s.risk_entry,
    },
    disclaimer: DISCLAIMER,
    updated_at: s.updated_at.toISOString(),
  };
}

@Controller("v1/series")
export class SeriesController {
  constructor(private repo: SeriesRepo, private cache: CacheService) {}

  @Get()
  list() {
    return this.cache.wrap("series:list", SERIES_TTL, async () => {
      const rows = await this.repo.list();
      const updated = rows.map((r) => r.updated_at.toISOString()).sort().at(-1) ?? null;
      return { data: rows.map((r) => presentSeries(r)), disclaimer: DISCLAIMER, updated_at: updated };
    });
  }

  @Get(":id")
  async get(@Param("id", new SeriesIdPipe()) id: string) {
    const s = await this.load(id);
    return presentSeries(s); // not cached: the countdown must be exact
  }

  @Get(":id/quote")
  async quote(@Param("id", new SeriesIdPipe()) id: string, @Query() q: QuoteQuery) {
    const s = await this.load(id);
    const q1 = buildQuote(s, q.tranche, toBaseUnits(q.amount, s.decimals));
    return { ...q1, disclaimer: DISCLAIMER, updated_at: s.updated_at.toISOString() };
  }

  /** Pure math, identical to the on-chain waterfall. Used by the scenario slider. */
  @Post(":id/simulate")
  @HttpCode(200)
  async simulate(@Param("id", new SeriesIdPipe()) id: string, @Body() body: SimulateBody) {
    const s = await this.load(id);
    return { ...buildSimulation(s, body.yieldBps), disclaimer: DISCLAIMER, updated_at: s.updated_at.toISOString() };
  }

  private async load(id: string): Promise<SeriesRow> {
    const s = await this.repo.get(id);
    if (!s) throw new NotFoundException(`unknown series ${id}`);
    return s;
  }
}
