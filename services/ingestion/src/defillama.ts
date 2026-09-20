import { readFileSync } from "fs";
import type { ProtocolRow, SnapshotRow } from "./types";

const BASE = "https://yields.llama.fi";

interface LlamaPool {
  pool: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
}
interface LlamaChartPoint {
  timestamp: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
}

const pct = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v / 100);

export function loadLiveProtocols(path: string): ProtocolRow[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Partial<ProtocolRow> & { id: string; name: string }>;
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category ?? "unknown",
    chain: "solana",
    launched: p.launched ?? null,
    synthetic: false,
    defillama_pool: p.defillama_pool ?? null,
    audit_urls: p.audit_urls ?? [],
    doc_urls: p.doc_urls ?? [],
  }));
}

export function snapshotFromPool(protocolId: string, p: LlamaPool, ts: Date): SnapshotRow {
  const base = pct(p.apyBase);
  const reward = pct(p.apyReward) ?? 0;
  return {
    protocol_id: protocolId,
    ts,
    tvl_usd: p.tvlUsd,
    apy_headline: pct(p.apy),
    apy_base: base,
    apy_reward: reward,
    share_rate: null, // DefiLlama has no share price; analytics falls back to mean base APY (labelled)
    reward_price: null,
    liquidity_ratio: null,
  };
}

export function snapshotsFromChart(protocolId: string, points: LlamaChartPoint[]): SnapshotRow[] {
  return points.map((c) => ({
    protocol_id: protocolId,
    ts: new Date(c.timestamp),
    tvl_usd: c.tvlUsd,
    apy_headline: pct(c.apy),
    apy_base: pct(c.apyBase),
    apy_reward: pct(c.apyReward) ?? 0,
    share_rate: null,
    reward_price: null,
    liquidity_ratio: null,
  }));
}

async function getJson<T>(url: string, f: typeof fetch): Promise<T> {
  const res = await f(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Current snapshot for every configured pool (one request for all). */
export async function fetchCurrent(protocols: ProtocolRow[], now: Date, f: typeof fetch = fetch): Promise<SnapshotRow[]> {
  const { data } = await getJson<{ data: LlamaPool[] }>(`${BASE}/pools`, f);
  const byPool = new Map(data.map((p) => [p.pool, p]));
  return protocols.flatMap((pr) => {
    const p = pr.defillama_pool ? byPool.get(pr.defillama_pool) : undefined;
    return p ? [snapshotFromPool(pr.id, p, now)] : [];
  });
}

export async function fetchHistory(protocol: ProtocolRow, f: typeof fetch = fetch): Promise<SnapshotRow[]> {
  if (!protocol.defillama_pool) return [];
  const { data } = await getJson<{ data: LlamaChartPoint[] }>(`${BASE}/chart/${protocol.defillama_pool}`, f);
  return snapshotsFromChart(protocol.id, data.slice(-45));
}
