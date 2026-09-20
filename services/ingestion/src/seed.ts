import { readFileSync } from "fs";
import { join } from "path";
import type { Doc, ProtocolRow, SnapshotRow } from "./types";

interface SeedProtocol {
  id: string;
  name: string;
  category: string;
  chain: string;
  launched: string;
  age_days: number;
  audit_urls: string[];
  doc_urls: string[];
  synthetic: boolean;
}
interface SeedSnapshot {
  day_offset: number;
  tvl_usd: number;
  apy_headline: number;
  apy_base: number;
  apy_reward: number;
  share_rate: number;
  reward_price: number | null;
  liquidity_ratio: number;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/**
 * Load the offline seed and re-time it so the newest point is "now" (floored to the hour, so repeated
 * runs within an hour are idempotent). `launched` is derived from the fixed `age_days` so risk scores stay stable.
 */
export function loadSeed(seedDir: string, now: Date): { protocols: ProtocolRow[]; snapshots: SnapshotRow[] } {
  const anchor = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const protocols = readJson<SeedProtocol[]>(join(seedDir, "protocols.json"));
  const snaps = readJson<{ snapshots: Record<string, SeedSnapshot[]> }>(join(seedDir, "snapshots.json")).snapshots;
  const rows: SnapshotRow[] = [];
  for (const p of protocols) {
    for (const s of snaps[p.id] ?? []) {
      rows.push({
        protocol_id: p.id,
        ts: new Date(anchor.getTime() + s.day_offset * 86_400_000),
        tvl_usd: s.tvl_usd,
        apy_headline: s.apy_headline,
        apy_base: s.apy_base,
        apy_reward: s.apy_reward,
        share_rate: s.share_rate,
        reward_price: s.reward_price,
        liquidity_ratio: s.liquidity_ratio,
      });
    }
  }
  return {
    protocols: protocols.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      chain: p.chain,
      launched: new Date(anchor.getTime() - p.age_days * 86_400_000).toISOString().slice(0, 10),
      synthetic: p.synthetic,
      defillama_pool: null,
      audit_urls: p.audit_urls,
      doc_urls: p.doc_urls,
    })),
    snapshots: rows,
  };
}

export function loadSeedDocs(seedDir: string, protocolId: string): Doc[] {
  return readJson<Doc[]>(join(seedDir, "docs", `${protocolId}.json`));
}
