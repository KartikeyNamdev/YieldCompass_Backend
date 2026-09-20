export interface ProtocolRow {
  id: string;
  name: string;
  category: string;
  chain: string;
  launched: string | null; // YYYY-MM-DD
  synthetic: boolean;
  defillama_pool: string | null;
  audit_urls: string[];
  doc_urls: string[];
}

export interface SnapshotRow {
  protocol_id: string;
  ts: Date;
  tvl_usd: number;
  apy_headline: number | null; // decimal fractions everywhere: 0.05 == 5%
  apy_base: number | null;
  apy_reward: number | null;
  share_rate: number | null;
  reward_price: number | null;
  liquidity_ratio: number | null;
}

export interface AnalyzeWindow {
  apy: number | null;
  period_return: number | null;
  days_used: number | null;
  basis: "share_rate" | "base_apy_average" | "insufficient_data";
}

export interface RiskFactor {
  factor: string;
  label: string;
  weight: number;
  value: number;
  points: number;
  reason: string;
  sources: Array<{ url: string | null; quote: string | null }>;
}

export interface AnalyzeResponse {
  protocol_id: string;
  realized: { "7d": AnalyzeWindow; "30d": AnalyzeWindow };
  emissions: { share: number; haircut: number; haircut_basis: string; price_change_30d: number | null; sustainable_apy: number };
  sustainable_realized_apy: number | null;
  risk: { protocol_id: string; score: number; breakdown: RiskFactor[]; sources: Array<{ url: string | null; quote: string | null }> };
}

export interface Doc {
  source: string;
  text: string;
}
