import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { RISK_ENTRY_TTL_SECS, fractionToBps, pdas, protocolIdToBytes } from "@yc/shared";
import type { Db, Programs } from "@yc/shared";
import * as tx from "./idempotency";

export interface PublishDeps {
  db: Db;
  programs: Programs; // provider wallet must be the risk authority
  riskAuthority: Keypair;
  now: () => Date;
}

export interface PublishResult {
  protocolId: string;
  status: "published" | "skipped";
  score?: number;
  signature?: string;
  expiresAt?: number;
}

/**
 * Write the latest off-chain score to the on-chain RiskEntry (24h expiry).
 * The score is read from the database, never trusted from the job payload, so a stale job can't publish an old number.
 */
export async function publishRisk(d: PublishDeps, protocolId: string, idempotencyKey: string): Promise<PublishResult> {
  const { rows } = await d.db.query(
    `SELECT r.score, r.computed_at, a.apy AS realized, a.emissions_share
       FROM risk_scores r LEFT JOIN realized_apy a ON a.protocol_id = r.protocol_id AND a.window_days = 30
      WHERE r.protocol_id = $1`,
    [protocolId],
  );
  if (rows.length === 0) throw new Error(`no risk score stored for ${protocolId}`);
  const score = Number(rows[0].score);
  const realizedBps = rows[0].realized === null ? 0 : fractionToBps(Number(rows[0].realized));
  const emissionsBps = fractionToBps(Number(rows[0].emissions_share ?? 0), 10_000);

  const key = `${idempotencyKey}-s${score}`;
  if (!(await tx.claim(d.db, key, "publish-risk"))) return { protocolId, status: "skipped" };
  try {
    const expiresAt = Math.floor(d.now().getTime() / 1000) + RISK_ENTRY_TTL_SECS;
    const id = protocolIdToBytes(protocolId);
    const p = pdas(d.programs.vault.programId);
    const signature: string = await d.programs.vault.methods
      .setRiskEntry(Array.from(id), score, realizedBps, emissionsBps, new BN(expiresAt))
      .accountsPartial({ authority: d.riskAuthority.publicKey, config: p.config(), riskEntry: p.risk(id) })
      .signers([d.riskAuthority])
      .rpc();
    await tx.confirm(d.db, key, signature, { protocolId, score, expiresAt });
    await d.db.query(
      `INSERT INTO risk_publications (protocol_id, score, expires_at, signature, published_at)
       VALUES ($1,$2,to_timestamp($3),$4,now())
       ON CONFLICT (protocol_id) DO UPDATE SET score=$2, expires_at=to_timestamp($3), signature=$4, published_at=now()`,
      [protocolId, score, expiresAt, signature],
    );
    return { protocolId, status: "published", score, signature, expiresAt };
  } catch (e) {
    await tx.fail(d.db, key, (e as Error).message);
    throw e;
  }
}

/**
 * The gate rejects stale entries, so scores must be re-published before they expire even when they did not change.
 * Returns protocol ids whose entry is missing or expires within `withinSecs`.
 */
export async function dueForRefresh(db: Db, withinSecs = 6 * 3600): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT r.protocol_id FROM risk_scores r LEFT JOIN risk_publications p ON p.protocol_id = r.protocol_id
      WHERE p.protocol_id IS NULL OR p.expires_at < now() + make_interval(secs => $1) ORDER BY 1`,
    [withinSecs],
  );
  return rows.map((r) => r.protocol_id as string);
}
