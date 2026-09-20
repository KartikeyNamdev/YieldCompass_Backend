import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { statusName, ycVaultIdl } from "@yc/shared";
import type { Programs } from "@yc/shared";
import type { Pool } from "pg";

const MAX_BACKFILL = 5_000;
const LAST_SIG = "last_signature";

/** Anchor may surface enum variants as `senior` or `Senior` depending on the decoder; normalise. */
const trancheName = (t: Record<string, unknown>): "senior" | "junior" => {
  const v = Object.keys(t)[0]?.toLowerCase();
  if (v !== "senior" && v !== "junior") throw new Error(`unknown tranche variant: ${v}`);
  return v;
};

export interface DecodedEvent {
  name: string;
  data: Record<string, any>;
}

/** Chain -> Postgres. Series rows mirror account state; positions are built from events, each tx applied exactly once. */
export class Indexer {
  private parser: EventParser;
  private decimals = new Map<string, number>();

  constructor(private db: Pool, private programs: Programs) {
    this.parser = new EventParser(programs.vault.programId, new BorshCoder(ycVaultIdl as never));
  }

  private get connection(): Connection {
    return this.programs.connection;
  }

  decode(logs: string[]): DecodedEvent[] {
    return [...this.parser.parseLogs(logs)] as DecodedEvent[];
  }

  // ------------------------------------------------------------------ series state
  private async mintDecimals(mint: PublicKey): Promise<number> {
    const k = mint.toBase58();
    if (!this.decimals.has(k)) this.decimals.set(k, (await getMint(this.connection, mint)).decimals);
    return this.decimals.get(k)!;
  }

  async upsertSeries(pubkey: PublicKey, a: any): Promise<void> {
    const ts = (n: { toNumber(): number }) => n.toNumber();
    const optTs = (n: { toNumber(): number }) => (ts(n) === 0 ? null : ts(n));
    await this.db.query(
      `INSERT INTO series (id, pubkey, status, rate_bps, term_secs, maturity_ts, senior_principal, junior_principal, senior_payout, junior_payout,
                           underlying_mint, decimals, senior_mint, junior_mint, vault, strategy_pool, risk_entry, deposit_deadline, start_ts,
                           min_junior_bps, min_risk_score, performance_fee_bps, updated_at)
       VALUES ($1,$2,$3,$4,$5, to_timestamp($6), $7,$8,$9,$10, $11,$12,$13,$14,$15,$16,$17, to_timestamp($18), to_timestamp($19), $20,$21,$22, now())
       ON CONFLICT (id) DO UPDATE SET pubkey=$2, status=$3, rate_bps=$4, term_secs=$5, maturity_ts=to_timestamp($6), senior_principal=$7,
         junior_principal=$8, senior_payout=$9, junior_payout=$10, underlying_mint=$11, decimals=$12, senior_mint=$13, junior_mint=$14, vault=$15,
         strategy_pool=$16, risk_entry=$17, deposit_deadline=to_timestamp($18), start_ts=to_timestamp($19), min_junior_bps=$20,
         min_risk_score=$21, performance_fee_bps=$22, updated_at=now()`,
      [
        a.id.toString(), pubkey.toBase58(), statusName(a.status), a.rateBps, a.termSecs.toString(), optTs(a.maturityTs),
        a.seniorPrincipal.toString(), a.juniorPrincipal.toString(), a.seniorPayout.toString(), a.juniorPayout.toString(),
        a.underlyingMint.toBase58(), await this.mintDecimals(a.underlyingMint), a.seniorMint.toBase58(), a.juniorMint.toBase58(),
        a.vault.toBase58(), a.strategyPool.toBase58(), a.riskEntry.toBase58(), ts(a.depositDeadline), optTs(a.startTs),
        a.minJuniorBps, a.minRiskScore, a.performanceFeeBps,
      ],
    );
  }

  async syncSeries(): Promise<number> {
    const all = await (this.programs.vault.account as any).series.all();
    for (const { publicKey, account } of all) await this.upsertSeries(publicKey, account);
    return all.length;
  }

  private async seriesIdFor(pubkey: string): Promise<string> {
    const r = await this.db.query("SELECT id FROM series WHERE pubkey=$1", [pubkey]);
    if (r.rows[0]) return String(r.rows[0].id);
    const account = await (this.programs.vault.account as any).series.fetch(new PublicKey(pubkey));
    await this.upsertSeries(new PublicKey(pubkey), account);
    return account.id.toString();
  }

  // ------------------------------------------------------------------ events
  /** Apply all events of one transaction atomically. Returns false if the signature was already processed. */
  async applyEvents(signature: string, slot: number, events: DecodedEvent[]): Promise<boolean> {
    const ids = new Map<string, string>();
    for (const e of events) {
      const s = e.data.series?.toBase58?.();
      if (s && !ids.has(s)) ids.set(s, await this.seriesIdFor(s));
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const fresh = await client.query("INSERT INTO processed_signatures (signature, slot) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1", [signature, slot]);
      if ((fresh.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const e of events) {
        const series = e.data.series?.toBase58?.();
        if (!series) continue;
        const id = ids.get(series)!;
        if (e.name === "Deposited" || e.name === "deposited") {
          await client.query(
            `INSERT INTO positions (series_id, owner, tranche, principal, claimed) VALUES ($1,$2,$3,$4,false)
             ON CONFLICT (series_id, owner, tranche) DO UPDATE SET principal = positions.principal + EXCLUDED.principal`,
            [id, e.data.user.toBase58(), trancheName(e.data.tranche), e.data.amount.toString()],
          );
        } else if (e.name === "Claimed" || e.name === "claimed") {
          await client.query("UPDATE positions SET claimed=true WHERE series_id=$1 AND owner=$2 AND tranche=$3", [id, e.data.user.toBase58(), trancheName(e.data.tranche)]);
        } else if (e.name === "Refunded" || e.name === "refunded") {
          await client.query("UPDATE positions SET claimed=true WHERE series_id=$1 AND owner=$2", [id, e.data.user.toBase58()]);
        }
      }
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async processSignature(signature: string): Promise<boolean> {
    const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || tx.meta.err) return false;
    return this.applyEvents(signature, tx.slot, this.decode(tx.meta.logMessages ?? []));
  }

  /** Catch up on transactions we have not seen (start-up, or after a dropped websocket). */
  async backfill(): Promise<number> {
    const cursor = (await this.db.query("SELECT value FROM indexer_state WHERE key=$1", [LAST_SIG])).rows[0]?.value as string | undefined;
    const pending: string[] = [];
    let before: string | undefined;
    outer: while (pending.length < MAX_BACKFILL) {
      const page = await this.connection.getSignaturesForAddress(this.programs.vault.programId, { before, limit: 100, until: cursor }, "confirmed");
      if (page.length === 0) break;
      for (const s of page) {
        if (!s.err) pending.push(s.signature);
        if (pending.length >= MAX_BACKFILL) break outer;
      }
      before = page[page.length - 1].signature;
    }
    let applied = 0;
    for (const sig of pending.reverse()) if (await this.processSignature(sig)) applied++;
    if (pending.length > 0) {
      await this.db.query(
        `INSERT INTO indexer_state (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
        [LAST_SIG, pending[pending.length - 1]],
      );
    }
    return applied;
  }

  /** One full reconciliation pass. */
  async runOnce(): Promise<{ series: number; applied: number }> {
    const applied = await this.backfill();
    const series = await this.syncSeries();
    return { series, applied };
  }

  subscribe(onError: (e: unknown) => void): number {
    return this.connection.onLogs(
      this.programs.vault.programId,
      (l, ctx) => {
        if (l.err) return;
        this.applyEvents(l.signature, ctx.slot, this.decode(l.logs)).then(() => this.syncSeries()).catch(onError);
      },
      "confirmed",
    );
  }
}
