import type { Pool } from "pg";
import type { Db } from "@yc/shared";
import type { AnalyzeResponse, ProtocolRow, RiskFactor, SnapshotRow } from "./types";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function upsertProtocols(db: Db, rows: ProtocolRow[]): Promise<void> {
  for (const p of rows) {
    await db.query(
      `INSERT INTO protocols (id, name, category, chain, launched, synthetic, defillama_pool, audit_urls, doc_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=$2, category=$3, chain=$4, launched=$5, synthetic=$6,
         defillama_pool=$7, audit_urls=$8, doc_urls=$9`,
      [p.id, p.name, p.category, p.chain, p.launched, p.synthetic, p.defillama_pool, JSON.stringify(p.audit_urls), JSON.stringify(p.doc_urls)],
    );
  }
}

export async function listProtocols(db: Db): Promise<ProtocolRow[]> {
  const { rows } = await db.query(
    `SELECT id, name, category, chain, to_char(launched,'YYYY-MM-DD') AS launched, synthetic, defillama_pool, audit_urls, doc_urls
     FROM protocols ORDER BY id`,
  );
  return rows as ProtocolRow[];
}

const SNAPSHOT_COLS = `protocol_id, ts, tvl_usd, apy_headline, apy_base, apy_reward, share_rate, reward_price, liquidity_ratio`;

function snapshotArrays(rows: SnapshotRow[]) {
  return [
    rows.map((r) => r.protocol_id),
    rows.map((r) => r.ts.toISOString()),
    rows.map((r) => r.tvl_usd),
    rows.map((r) => r.apy_headline),
    rows.map((r) => r.apy_base),
    rows.map((r) => r.apy_reward),
    rows.map((r) => r.share_rate),
    rows.map((r) => r.reward_price),
    rows.map((r) => r.liquidity_ratio),
  ];
}

const UNNEST = `SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])`;

export async function insertSnapshots(db: Db, rows: SnapshotRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await db.query(
    `INSERT INTO pool_snapshots (${SNAPSHOT_COLS}) ${UNNEST}
     ON CONFLICT (protocol_id, ts) DO UPDATE SET tvl_usd=EXCLUDED.tvl_usd, apy_headline=EXCLUDED.apy_headline,
       apy_base=EXCLUDED.apy_base, apy_reward=EXCLUDED.apy_reward, share_rate=EXCLUDED.share_rate,
       reward_price=EXCLUDED.reward_price, liquidity_ratio=EXCLUDED.liquidity_ratio`,
    snapshotArrays(rows),
  );
  return res.rowCount ?? 0;
}

/** Demo mode: replace all snapshots of the given protocols atomically (re-timed seed never piles up). */
export async function replaceSnapshots(pool: Pool, protocolIds: string[], rows: SnapshotRow[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM pool_snapshots WHERE protocol_id = ANY($1::text[])", [protocolIds]);
    const n = await insertSnapshots(client, rows);
    await client.query("COMMIT");
    return n;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function getSnapshots(db: Db, protocolId: string, days = 40): Promise<SnapshotRow[]> {
  const { rows } = await db.query(
    `SELECT ${SNAPSHOT_COLS} FROM pool_snapshots
     WHERE protocol_id = $1 AND ts >= (SELECT max(ts) FROM pool_snapshots WHERE protocol_id = $1) - make_interval(days => $2)
     ORDER BY ts`,
    [protocolId, days],
  );
  return rows.map((r) => ({
    protocol_id: r.protocol_id,
    ts: new Date(r.ts),
    tvl_usd: Number(r.tvl_usd),
    apy_headline: num(r.apy_headline),
    apy_base: num(r.apy_base),
    apy_reward: num(r.apy_reward),
    share_rate: num(r.share_rate),
    reward_price: num(r.reward_price),
    liquidity_ratio: num(r.liquidity_ratio),
  }));
}

export async function countSnapshots(db: Db, protocolId: string): Promise<number> {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM pool_snapshots WHERE protocol_id = $1", [protocolId]);
  return rows[0].n as number;
}

export async function upsertRealized(db: Db, protocolId: string, windowDays: number, a: AnalyzeResponse, now: Date): Promise<void> {
  const w = windowDays === 7 ? a.realized["7d"] : a.realized["30d"];
  await db.query(
    `INSERT INTO realized_apy (protocol_id, window_days, apy, emissions_share, computed_at, basis, period_return, sustainable_realized_apy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (protocol_id, window_days) DO UPDATE SET apy=$3, emissions_share=$4, computed_at=$5, basis=$6,
       period_return=$7, sustainable_realized_apy=$8`,
    [protocolId, windowDays, w.apy, a.emissions.share, now.toISOString(), w.basis, w.period_return, windowDays === 30 ? a.sustainable_realized_apy : null],
  );
}

export interface StoredRisk {
  score: number;
  computed_at: Date;
}

export async function getRisk(db: Db, protocolId: string): Promise<StoredRisk | null> {
  const { rows } = await db.query("SELECT score, computed_at FROM risk_scores WHERE protocol_id = $1", [protocolId]);
  return rows[0] ? { score: rows[0].score, computed_at: new Date(rows[0].computed_at) } : null;
}

export async function countRisk(db: Db): Promise<number> {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM risk_scores");
  return rows[0].n as number;
}

export async function upsertRisk(
  db: Db,
  protocolId: string,
  score: number,
  breakdown: RiskFactor[],
  explanation: string,
  explanationSource: string,
  sources: unknown[],
  computedAt: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO risk_scores (protocol_id, score, breakdown, explanation, sources, computed_at, explanation_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (protocol_id) DO UPDATE SET score=$2, breakdown=$3, explanation=$4, sources=$5, computed_at=$6, explanation_source=$7`,
    [protocolId, score, JSON.stringify(breakdown), explanation, JSON.stringify(sources), computedAt.toISOString(), explanationSource],
  );
}
