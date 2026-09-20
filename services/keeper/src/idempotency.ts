import type { Db } from "@yc/shared";

/**
 * Claim the right to submit an on-chain action. Returns true only for the caller that should send the tx.
 *  - new key                      -> claimed
 *  - key confirmed                -> false (already done)
 *  - key pending and fresh        -> false (another worker is on it)
 *  - key pending/failed and stale -> re-claimed (previous attempt crashed or failed)
 */
export async function claim(db: Db, key: string, kind: string, staleAfterSecs = 90): Promise<boolean> {
  const ins = await db.query(
    `INSERT INTO tx_log (idempotency_key, kind, status) VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING RETURNING 1`,
    [key, kind],
  );
  if ((ins.rowCount ?? 0) > 0) return true;
  const re = await db.query(
    `UPDATE tx_log SET status='pending', updated_at=now()
     WHERE idempotency_key=$1 AND status <> 'confirmed'
       AND (status = 'failed' OR updated_at < now() - make_interval(secs => $2)) RETURNING 1`,
    [key, staleAfterSecs],
  );
  return (re.rowCount ?? 0) > 0;
}

export async function confirm(db: Db, key: string, signature: string | null, detail: unknown = {}): Promise<void> {
  await db.query(`UPDATE tx_log SET status='confirmed', signature=$2, detail=$3, updated_at=now() WHERE idempotency_key=$1`, [
    key,
    signature,
    JSON.stringify(detail),
  ]);
}

export async function fail(db: Db, key: string, error: string): Promise<void> {
  await db.query(`UPDATE tx_log SET status='failed', detail=$2, updated_at=now() WHERE idempotency_key=$1`, [key, JSON.stringify({ error })]);
}

/** Forget an attempt entirely (used when the action is simply not due yet). */
export async function release(db: Db, key: string): Promise<void> {
  await db.query(`DELETE FROM tx_log WHERE idempotency_key=$1 AND status <> 'confirmed'`, [key]);
}
