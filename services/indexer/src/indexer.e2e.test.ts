/** Real local validator + Postgres; run via scripts/e2e-keeper.sh. Skipped otherwise. */
import { Connection, Keypair } from "@solana/web3.js";
import { getPrograms, runMigrations } from "@yc/shared";
import { D, bootstrap } from "@yc/testkit";
import { resolve } from "path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { Indexer } from "./indexer";

const RPC = process.env.TEST_RPC_URL;
const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!RPC || !DB)("indexer end to end (local validator)", () => {
  it("mirrors series state and builds positions from events, exactly once", async () => {
    const conn = new Connection(RPC!, "confirmed");
    const db = new Pool({ connectionString: DB });
    await runMigrations(db, resolve(__dirname, "../../../migrations"));
    await db.query("TRUNCATE positions, series, processed_signatures, indexer_state");

    const c = await bootstrap(conn);
    await c.setRisk("idx-demo", 85, 3600);
    const s = await c.createSeries(201, "idx-demo", { deadlineIn: 6, term: 5 });
    await c.deposit(s, c.bob, "junior", 20);
    await c.deposit(s, c.alice, "senior", 30);
    await c.deposit(s, c.alice, "senior", 30); // same owner twice: principal accumulates
    await c.deposit(s, c.carol, "senior", 40 );

    const indexer = new Indexer(db, getPrograms(conn, Keypair.generate()));
    const first = await indexer.runOnce();
    expect(first.applied).toBeGreaterThanOrEqual(4);

    const row = (await db.query("SELECT * FROM series WHERE id=201")).rows[0];
    expect(row.status).toBe("open");
    expect(row.pubkey).toBe(s.series.toBase58());
    expect(Number(row.senior_principal)).toBe(100 * D);
    expect(Number(row.junior_principal)).toBe(20 * D);
    expect(row.rate_bps).toBe(200);
    expect(row.decimals).toBe(6);
    expect(row.maturity_ts).toBeNull();
    expect(row.protocol_id).toBe("idx-demo"); // read from the on-chain RiskEntry
    expect(row.risk_score).toBe(85);
    expect(row.risk_expires_at).not.toBeNull();
    const pos = async () =>
      Object.fromEntries((await db.query("SELECT owner, tranche, principal, claimed FROM positions WHERE series_id=201")).rows
        .map((r) => [`${r.owner}:${r.tranche}`, { principal: Number(r.principal), claimed: r.claimed }]));
    expect(await pos()).toEqual({
      [`${c.alice.publicKey}:senior`]: { principal: 60 * D, claimed: false },
      [`${c.carol.publicKey}:senior`]: { principal: 40 * D, claimed: false },
      [`${c.bob.publicKey}:junior`]: { principal: 20 * D, claimed: false },
    });

    // re-running must not double count
    const second = await indexer.runOnce();
    expect(second.applied).toBe(0);
    expect((await pos())[`${c.alice.publicKey}:senior`].principal).toBe(60 * D);

    // lifecycle: activate, profit, settle, one senior + the junior claim
    await c.waitUntil(s.deadline);
    await c.activate(s, c.bob);
    await c.simulateYield(s, 600);
    const maturity = (await c.accounts("vault").series.fetch(s.series)).maturityTs.toNumber();
    await c.waitUntil(maturity);
    await c.settle(s, c.keeper);
    await c.claim(s, c.alice, "senior");
    await c.claim(s, c.bob, "junior");

    await indexer.runOnce();
    const after = (await db.query("SELECT status, senior_payout, junior_payout, maturity_ts, start_ts FROM series WHERE id=201")).rows[0];
    expect(after.status).toBe("settled");
    expect(Number(after.senior_payout) + Number(after.junior_payout)).toBe(127_200_000); // 120 * 1.06
    expect(after.maturity_ts).not.toBeNull();
    expect(after.start_ts).not.toBeNull();
    const p2 = await pos();
    expect(p2[`${c.alice.publicKey}:senior`].claimed).toBe(true);
    expect(p2[`${c.bob.publicKey}:junior`].claimed).toBe(true);
    expect(p2[`${c.carol.publicKey}:senior`].claimed).toBe(false); // has not claimed yet
    await db.end();
  }, 120_000);
});
