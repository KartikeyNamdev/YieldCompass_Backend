import { Inject, Injectable } from "@nestjs/common";
import type { Db } from "@yc/shared/dist/db";
import type { SeriesFacts } from "../lib/quote";
import { PG } from "../infra/tokens";

const big = (v: unknown): bigint => BigInt(String(v ?? 0).split(".")[0]);
const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);

export interface SeriesRow extends SeriesFacts {
  pubkey: string;
  senior_payout: bigint;
  junior_payout: bigint;
  min_risk_score: number;
  start_ts: Date | null;
  underlying_mint: string;
  senior_mint: string;
  junior_mint: string;
  vault: string;
  strategy_pool: string;
  risk_entry: string;
  updated_at: Date;
}

export interface PositionRow {
  series: SeriesRow;
  tranche: "senior" | "junior";
  principal: bigint;
  claimed: boolean;
}

export function toSeries(r: Record<string, any>): SeriesRow {
  return {
    id: String(r.id), pubkey: r.pubkey, status: r.status, rate_bps: r.rate_bps, term_secs: Number(r.term_secs), decimals: r.decimals,
    senior_principal: big(r.senior_principal), junior_principal: big(r.junior_principal), senior_payout: big(r.senior_payout),
    junior_payout: big(r.junior_payout), min_junior_bps: r.min_junior_bps, min_risk_score: r.min_risk_score,
    deposit_deadline: date(r.deposit_deadline), start_ts: date(r.start_ts), maturity_ts: date(r.maturity_ts),
    underlying_mint: r.underlying_mint, senior_mint: r.senior_mint, junior_mint: r.junior_mint, vault: r.vault,
    strategy_pool: r.strategy_pool, risk_entry: r.risk_entry, updated_at: new Date(r.updated_at),
  };
}

@Injectable()
export class SeriesRepo {
  constructor(@Inject(PG) private db: Db) {}

  async list(): Promise<SeriesRow[]> {
    const { rows } = await this.db.query("SELECT * FROM series ORDER BY id DESC LIMIT 100");
    return rows.map(toSeries);
  }

  async get(id: string): Promise<SeriesRow | null> {
    const { rows } = await this.db.query("SELECT * FROM series WHERE id = $1", [id]);
    return rows[0] ? toSeries(rows[0]) : null;
  }

  async positions(owner: string): Promise<PositionRow[]> {
    const { rows } = await this.db.query(
      `SELECT s.*, p.tranche, p.principal AS position_principal, p.claimed
         FROM positions p JOIN series s ON s.id = p.series_id WHERE p.owner = $1 ORDER BY s.id DESC, p.tranche`,
      [owner],
    );
    return rows.map((r) => ({ series: toSeries(r), tranche: r.tranche, principal: big(r.position_principal), claimed: r.claimed }));
  }
}
