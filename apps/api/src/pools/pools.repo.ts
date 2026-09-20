import { Inject, Injectable } from "@nestjs/common";
import type { Db } from "@yc/shared/dist/db";
import type { PoolSummary } from "../lib/ranking";
import { PG } from "../infra/tokens";

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => new Date(v as string).toISOString();

export interface RiskDetail {
  protocol_id: string;
  score: number;
  breakdown: unknown[];
  sources: unknown[];
  explanation: string;
  explanation_source: string | null;
  computed_at: string;
}

export interface HistoryPoint {
  ts: string;
  tvl_usd: number;
  apy_headline: number | null;
  apy_base: number | null;
  apy_reward: number | null;
  share_rate: number | null;
}

@Injectable()
export class PoolsRepo {
  constructor(@Inject(PG) private db: Db) {}

  async listPools(): Promise<PoolSummary[]> {
    const { rows } = await this.db.query(POOL_SQL + " ORDER BY p.id");
    return rows.map(toSummary);
  }

  async getPool(id: string): Promise<PoolSummary | null> {
    const { rows } = await this.db.query(POOL_SQL + " WHERE p.id = $1", [id]);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async getRisk(id: string): Promise<RiskDetail | null> {
    const { rows } = await this.db.query(
      "SELECT protocol_id, score, breakdown, sources, explanation, explanation_source, computed_at FROM risk_scores WHERE protocol_id=$1",
      [id],
    );
    const r = rows[0];
    return r ? { ...r, computed_at: iso(r.computed_at) } : null;
  }

  async history(id: string, days: number): Promise<HistoryPoint[]> {
    const { rows } = await this.db.query(
      `SELECT ts, tvl_usd, apy_headline, apy_base, apy_reward, share_rate FROM pool_snapshots
        WHERE protocol_id=$1 AND ts >= (SELECT max(ts) FROM pool_snapshots WHERE protocol_id=$1) - make_interval(days => $2)
        ORDER BY ts`,
      [id, days],
    );
    return rows.map((r) => ({
      ts: iso(r.ts), tvl_usd: Number(r.tvl_usd), apy_headline: n(r.apy_headline), apy_base: n(r.apy_base),
      apy_reward: n(r.apy_reward), share_rate: n(r.share_rate),
    }));
  }
}

const POOL_SQL = `
SELECT p.id, p.name, p.category, p.chain, p.synthetic,
       s.ts AS as_of, s.tvl_usd, s.apy_headline, s.apy_base, s.apy_reward,
       r7.apy AS realized_7d, r30.apy AS realized_30d, r30.basis AS realized_basis, r30.emissions_share,
       r30.sustainable_realized_apy, k.score AS risk_score
  FROM protocols p
  JOIN LATERAL (SELECT * FROM pool_snapshots WHERE protocol_id = p.id ORDER BY ts DESC LIMIT 1) s ON true
  LEFT JOIN realized_apy r7  ON r7.protocol_id  = p.id AND r7.window_days  = 7
  LEFT JOIN realized_apy r30 ON r30.protocol_id = p.id AND r30.window_days = 30
  LEFT JOIN risk_scores k ON k.protocol_id = p.id`;

export function toSummary(r: Record<string, unknown>): PoolSummary {
  const headline = n(r.apy_headline);
  const r30 = n(r.realized_30d);
  const sustainable = n(r.sustainable_realized_apy);
  const score = n(r.risk_score);
  const share = n(r.emissions_share);
  return {
    id: r.id as string,
    name: r.name as string,
    category: r.category as string,
    chain: r.chain as string,
    data_source: r.synthetic ? "seed-synthetic" : "live",
    headline_apy: headline,
    realized_apy_7d: n(r.realized_7d),
    realized_apy_30d: r30,
    realized_basis: (r.realized_basis as string) ?? null,
    emissions_share: share,
    mostly_bonus_tokens: (share ?? 0) > 0.5,
    gap: { advertised: headline, realized: r30, gap_points: headline !== null && r30 !== null ? headline - r30 : null },
    tvl_usd: Number(r.tvl_usd),
    risk_score: score,
    sustainable_realized_apy: sustainable,
    risk_adjusted_yield: sustainable !== null && score !== null ? sustainable * (score / 100) : null,
    updated_at: iso(r.as_of),
  };
}
