/**
 * End-to-end against a REAL local validator (programs preloaded) and Postgres. Skipped unless both are configured:
 *   scripts/e2e-keeper.sh     (starts validator + local infra and runs this file)
 */
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getPrograms, pdas, protocolIdToBytes, runMigrations, statusName } from "@yc/shared";
import { resolve } from "path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { anchorErrorCode } from "./errors";
import { dueForRefresh, publishRisk } from "./publishRisk";
import { settleMatured } from "./settle";

const RPC = process.env.TEST_RPC_URL;
const DB = process.env.TEST_DATABASE_URL;
const D = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RPC || !DB)("keeper end to end (local validator)", () => {
  it("publishes risk, enforces the gate, and settles a matured series without manual action", async () => {
    const conn = new Connection(RPC!, "confirmed");
    const db = new Pool({ connectionString: DB });
    await runMigrations(db, resolve(__dirname, "../../../migrations"));
    await db.query("TRUNCATE tx_log, risk_publications, risk_scores, realized_apy");

    const [admin, riskAuth, keeper, alice, bob] = [1, 2, 3, 4, 5].map(() => Keypair.generate());
    for (const k of [admin, riskAuth, keeper, alice, bob]) {
      const sig = await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    const as = (k: Keypair) => getPrograms(conn, k);
    const A = as(admin), R = as(riskAuth), K = as(keeper);
    const p = pdas(A.vault.programId);

    const mint = await createMint(conn, admin, admin.publicKey, null, 6);
    const ata = async (owner: Keypair, m: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, owner, m, owner.publicKey)).address;
    for (const u of [alice, bob]) await mintTo(conn, admin, mint, await ata(u, mint), admin, 1000 * D);

    await A.vault.methods.initConfig(admin.publicKey, riskAuth.publicKey).accountsPartial({ payer: admin.publicKey, config: p.config() }).rpc();

    // off-chain scores as produced by the analytics pipeline
    const putScore = async (id: string, score: number, apy: number, em: number) => {
      await db.query(
        `INSERT INTO risk_scores (protocol_id, score, breakdown, explanation, sources, computed_at) VALUES ($1,$2,'[]','x','[]',now())
         ON CONFLICT (protocol_id) DO UPDATE SET score=$2`, [id, score]);
      await db.query(
        `INSERT INTO realized_apy (protocol_id, window_days, apy, emissions_share, computed_at) VALUES ($1,30,$2,$3,now())
         ON CONFLICT (protocol_id, window_days) DO UPDATE SET apy=$2, emissions_share=$3`, [id, apy, em]);
    };
    await putScore("demo-good", 85, 0.059, 0.2);
    await putScore("demo-low", 40, 0.31, 0.9);

    const pubDeps = { db, programs: R.vault ? R : R, riskAuthority: riskAuth, now: () => new Date() };

    // ---- 1. keeper publishes RiskEntry accounts, idempotently
    const r1 = await publishRisk(pubDeps, "demo-good", "job-1");
    expect(r1.status).toBe("published");
    const entry = await (A.vault.account as any).riskEntry.fetch(p.risk(protocolIdToBytes("demo-good")));
    expect(entry.score).toBe(85);
    expect(entry.realizedApyBps).toBe(590);
    expect(entry.emissionsBps).toBe(2000);
    expect(Math.abs(entry.expiresAt.toNumber() - entry.updatedAt.toNumber() - 24 * 3600)).toBeLessThanOrEqual(5); // 24h, modulo local vs chain clock skew
    expect((await publishRisk(pubDeps, "demo-good", "job-1")).status).toBe("skipped"); // same idempotency key + score
    expect((await publishRisk(pubDeps, "demo-low", "job-2")).status).toBe("published");
    expect(await dueForRefresh(db)).toEqual([]); // both fresh
    await db.query("UPDATE risk_publications SET expires_at = now() + interval '1 hour' WHERE protocol_id='demo-good'");
    expect(await dueForRefresh(db)).toEqual(["demo-good"]); // close to expiry -> refresh

    // ---- helpers to run a short series against the mock strategy
    const mk = async (id: number, protocol: string, minScore: number, deadlineIn: number, term: number) => {
      const series = p.series(id);
      const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), series.toBuffer()], A.mock.programId)[0];
      const sub = (tag: string, base: PublicKey, prog: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), base.toBuffer()], prog)[0];
      const s = {
        id, series, pool, term,
        poolVault: sub("pool_vault", pool, A.mock.programId), reserve: sub("reserve", pool, A.mock.programId),
        sink: sub("sink", pool, A.mock.programId), vault: sub("vault", series, A.vault.programId),
        seniorMint: sub("senior_mint", series, A.vault.programId), juniorMint: sub("junior_mint", series, A.vault.programId),
        risk: p.risk(protocolIdToBytes(protocol)),
      };
      await A.mock.methods.initPool(series).accountsPartial({ admin: admin.publicKey, mint, pool, poolVault: s.poolVault, reserve: s.reserve, sink: s.sink }).rpc();
      await mintTo(conn, admin, mint, s.reserve, admin, 50 * D);
      const deadline = Math.floor(Date.now() / 1000) + deadlineIn;
      await A.vault.methods
        .initSeries({ id: new BN(id), rateBps: 200, termSecs: new BN(term), depositDeadline: new BN(deadline), minJuniorBps: 1000, minRiskScore: minScore, performanceFeeBps: 0 })
        .accountsPartial({ admin: admin.publicKey, config: p.config(), underlyingMint: mint, series, vault: s.vault, seniorMint: s.seniorMint, juniorMint: s.juniorMint, strategyPool: pool, riskEntry: s.risk })
        .rpc();
      const dep = async (u: Keypair, tranche: "senior" | "junior", amt: number) => {
        const shareMint = tranche === "senior" ? s.seniorMint : s.juniorMint;
        const m = as(u).vault.methods;
        await (tranche === "senior" ? m.depositSenior : m.depositJunior)(new BN(amt * D))
          .accountsPartial({ user: u.publicKey, config: p.config(), series, vault: s.vault, shareMint, userUnderlying: await ata(u, mint), userShares: await ata(u, shareMint) })
          .rpc();
      };
      await dep(bob, "junior", 20);
      await dep(alice, "senior", 100);
      return { ...s, deadline, dep };
    };
    const activate = (s: Awaited<ReturnType<typeof mk>>, caller: Keypair) =>
      as(caller).vault.methods.activate().accountsPartial({ caller: caller.publicKey, config: p.config(), series: s.series, riskEntry: s.risk, vault: s.vault, strategyPool: s.pool, poolVault: s.poolVault }).rpc();
    const waitUntil = async (ts: number) => { while (Date.now() / 1000 < ts + 2) await sleep(500); };
    const status = async (s: { series: PublicKey }) => statusName((await (A.vault.account as any).series.fetch(s.series)).status);

    // ---- 2. the gate: a low score is refused by the PROGRAM
    const low = await mk(101, "demo-low", 60, 6, 5);
    await waitUntil(low.deadline);
    await expect(activate(low, bob)).rejects.toSatisfy((e: unknown) => anchorErrorCode(e) === "RiskScoreTooLow");
    expect(await status(low)).toBe("open");

    // ---- 3. the gate: a stale entry is refused, then refreshed by the keeper
    const now = Math.floor(Date.now() / 1000);
    await putScore("demo-stale", 80, 0.05, 0.1);
    await R.vault.methods.setRiskEntry(Array.from(protocolIdToBytes("demo-stale")), 80, 500, 1000, new BN(now + 6))
      .accountsPartial({ authority: riskAuth.publicKey, config: p.config(), riskEntry: p.risk(protocolIdToBytes("demo-stale")) }).rpc();
    const stale = await mk(102, "demo-stale", 60, 8, 5);
    await waitUntil(stale.deadline);
    await expect(activate(stale, bob)).rejects.toSatisfy((e: unknown) => anchorErrorCode(e) === "RiskEntryStale");
    expect((await publishRisk(pubDeps, "demo-stale", "refresh-1")).status).toBe("published");
    await activate(stale, bob); // now allowed: fresh and score 80 >= 60
    expect(await status(stale)).toBe("active");

    // ---- 4. healthy series: activate, simulate profit, and let the keeper settle with no manual step
    const good = await mk(103, "demo-good", 60, 6, 6);
    await waitUntil(good.deadline);
    await publishRisk(pubDeps, "demo-good", "refresh-2");
    await activate(good, bob);
    const startTs = (await (A.vault.account as any).series.fetch(good.series)).maturityTs.toNumber();
    await A.mock.methods.simulateYield(600).accountsPartial({ admin: admin.publicKey, pool: good.pool, poolVault: good.poolVault, reserve: good.reserve, sink: good.sink }).rpc();

    const kDeps = { db, programs: K, keeper, now: () => new Date() };
    const early = await settleMatured(kDeps);
    expect(early.settled).toContain(stale.series.toBase58()); // the earlier 5s series has matured: settled automatically
    expect(early.settled).not.toContain(good.series.toBase58()); // this one has not
    expect(early.notDue).toContain(good.series.toBase58());

    await waitUntil(startTs);
    const done = await settleMatured(kDeps);
    expect(done.settled).toEqual([good.series.toBase58()]);
    expect(done.failed).toEqual([]);
    const settled = await (A.vault.account as any).series.fetch(good.series);
    expect(statusName(settled.status)).toBe("settled");
    // 120 USDC * 1.06 = 127.2 ; senior target ~100.00004 (2% for 6s), junior gets the rest
    expect(settled.seniorPayout.toNumber() + settled.juniorPayout.toNumber()).toBe(127_200_000);
    expect(settled.seniorPayout.toNumber()).toBeLessThan(100.01 * D);

    const again = await settleMatured(kDeps);
    expect(again.settled).toEqual([]); // idempotent: nothing left to do
    const log = await db.query("SELECT status FROM tx_log WHERE kind='settle' AND idempotency_key = $1", [`settle-${good.series.toBase58()}`]);
    expect(log.rows).toEqual([{ status: "confirmed" }]);

    // depositors can claim what the keeper settled
    const before = (await getAccount(conn, await ata(alice, mint))).amount;
    await as(alice).vault.methods.claimSenior()
      .accountsPartial({ user: alice.publicKey, series: good.series, vault: good.vault, shareMint: good.seniorMint, userShares: await ata(alice, good.seniorMint), userUnderlying: await ata(alice, mint) }).rpc();
    expect((await getAccount(conn, await ata(alice, mint))).amount - before).toBe(BigInt(settled.seniorPayout.toString()));
    await db.end();
  }, 180_000);
});
