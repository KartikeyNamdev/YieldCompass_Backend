export type Profile = "conservative" | "balanced" | "aggressive";
export type SortKey = "risk_adjusted" | "headline" | "realized" | "tvl" | "risk";

export interface PoolSummary {
  id: string;
  name: string;
  category: string;
  chain: string;
  data_source: "seed-synthetic" | "live";
  headline_apy: number | null;
  realized_apy_7d: number | null;
  realized_apy_30d: number | null;
  realized_basis: string | null;
  emissions_share: number | null;
  mostly_bonus_tokens: boolean;
  gap: { advertised: number | null; realized: number | null; gap_points: number | null };
  tvl_usd: number;
  risk_score: number | null;
  sustainable_realized_apy: number | null;
  risk_adjusted_yield: number | null;
  updated_at: string;
}

/**
 * Profiles change both WHO is eligible and how hard the risk score is weighted:
 *   ranked value = sustainable_realized_apy * (risk_score / 100) ^ exponent
 * With exponent 1 this is exactly the spec's `realized_apy x risk_score / 100` (using the emissions-haircut adjusted realized APY).
 */
export const PROFILES: Record<Profile, { minScore: number; maxEmissionsShare: number; exponent: number; description: string }> = {
  conservative: { minScore: 65, maxEmissionsShare: 0.5, exponent: 2, description: "Risk score >= 65, no pools that are mostly bonus tokens, risk weighted twice" },
  balanced: { minScore: 40, maxEmissionsShare: 1, exponent: 1, description: "Risk score >= 40, ranked by realized APY x risk score / 100" },
  aggressive: { minScore: 0, maxEmissionsShare: 1, exponent: 0.5, description: "All pools, risk weighted lightly" },
};

export function eligibility(p: PoolSummary, profile: Profile): string | null {
  const cfg = PROFILES[profile];
  if (p.risk_score === null) return "no risk score yet";
  if (p.risk_score < cfg.minScore) return `risk score ${p.risk_score} is below the ${profile} minimum of ${cfg.minScore}`;
  if ((p.emissions_share ?? 0) > cfg.maxEmissionsShare) return "mostly bonus tokens";
  return null;
}

export function profileValue(p: PoolSummary, profile: Profile): number | null {
  if (p.sustainable_realized_apy === null || p.risk_score === null) return null;
  return p.sustainable_realized_apy * Math.pow(p.risk_score / 100, PROFILES[profile].exponent);
}

const sortValue = (p: PoolSummary, sort: SortKey, profile: Profile): number | null => {
  switch (sort) {
    case "risk_adjusted": return profileValue(p, profile);
    case "headline": return p.headline_apy;
    case "realized": return p.realized_apy_30d;
    case "tvl": return p.tvl_usd;
    case "risk": return p.risk_score;
  }
};

/** Descending; nulls last; ties broken by id so the order is deterministic. */
export function rankPools(pools: PoolSummary[], profile: Profile, sort: SortKey) {
  const included: PoolSummary[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  for (const p of pools) {
    const why = eligibility(p, profile);
    if (why) excluded.push({ id: p.id, reason: why });
    else included.push(p);
  }
  included.sort((a, b) => {
    const [x, y] = [sortValue(a, sort, profile), sortValue(b, sort, profile)];
    if (x === null && y === null) return a.id.localeCompare(b.id);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x || a.id.localeCompare(b.id);
  });
  return { included, excluded };
}
