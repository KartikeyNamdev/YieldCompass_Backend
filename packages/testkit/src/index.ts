/** Helpers for tests that talk to a real (local) validator. Not used by production code. */
import { BN } from "@coral-xyz/anchor";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getPrograms, pdas, protocolIdToBytes, statusName } from "@yc/shared";

export const D = 1_000_000; // 1 unit of the 6-decimal test stablecoin
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SeriesHandle {
  id: number;
  series: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
  reserve: PublicKey;
  sink: PublicKey;
  vault: PublicKey;
  seniorMint: PublicKey;
  juniorMint: PublicKey;
  risk: PublicKey;
  deadline: number;
}

export async function bootstrap(conn: Connection) {
  const [admin, riskAuth, keeper, alice, bob, carol] = Array.from({ length: 6 }, () => Keypair.generate());
  for (const k of [admin, riskAuth, keeper, alice, bob, carol]) {
    await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  }
  const as = (k: Keypair) => getPrograms(conn, k);
  const A = as(admin);
  const p = pdas(A.vault.programId);
  const mint = await createMint(conn, admin, admin.publicKey, null, 6);
  const ata = async (owner: Keypair, m: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, owner, m, owner.publicKey)).address;
  for (const u of [alice, bob, carol]) await mintTo(conn, admin, mint, await ata(u, mint), admin, 1000 * D);
  await A.vault.methods.initConfig(admin.publicKey, riskAuth.publicKey).accountsPartial({ payer: admin.publicKey, config: p.config() }).rpc();

  const accounts = (prog: "vault" | "mock") => (A[prog].account as any);
  const sub = (tag: string, base: PublicKey, prog: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), base.toBuffer()], prog)[0];

  async function setRisk(protocol: string, score: number, ttlSecs: number) {
    const id = protocolIdToBytes(protocol);
    await as(riskAuth).vault.methods.setRiskEntry(Array.from(id), score, 500, 1000, new BN(Math.floor(Date.now() / 1000) + ttlSecs))
      .accountsPartial({ authority: riskAuth.publicKey, config: p.config(), riskEntry: p.risk(id) }).rpc();
  }

  async function createSeries(id: number, protocol: string, o: { minScore?: number; deadlineIn: number; term: number; reserve?: number }): Promise<SeriesHandle> {
    const series = p.series(id);
    const pool = sub("pool", series, A.mock.programId);
    const s: SeriesHandle = {
      id, series, pool, poolVault: sub("pool_vault", pool, A.mock.programId), reserve: sub("reserve", pool, A.mock.programId),
      sink: sub("sink", pool, A.mock.programId), vault: sub("vault", series, A.vault.programId),
      seniorMint: sub("senior_mint", series, A.vault.programId), juniorMint: sub("junior_mint", series, A.vault.programId),
      risk: p.risk(protocolIdToBytes(protocol)), deadline: Math.floor(Date.now() / 1000) + o.deadlineIn,
    };
    await A.mock.methods.initPool(series).accountsPartial({ admin: admin.publicKey, mint, pool, poolVault: s.poolVault, reserve: s.reserve, sink: s.sink }).rpc();
    await mintTo(conn, admin, mint, s.reserve, admin, (o.reserve ?? 50) * D);
    await A.vault.methods
      .initSeries({ id: new BN(id), rateBps: 200, termSecs: new BN(o.term), depositDeadline: new BN(s.deadline), minJuniorBps: 1000, minRiskScore: o.minScore ?? 60, performanceFeeBps: 0 })
      .accountsPartial({ admin: admin.publicKey, config: p.config(), underlyingMint: mint, series, vault: s.vault, seniorMint: s.seniorMint, juniorMint: s.juniorMint, strategyPool: pool, riskEntry: s.risk })
      .rpc();
    return s;
  }

  async function deposit(s: SeriesHandle, user: Keypair, tranche: "senior" | "junior", units: number): Promise<string> {
    const shareMint = tranche === "senior" ? s.seniorMint : s.juniorMint;
    const m = as(user).vault.methods;
    return (tranche === "senior" ? m.depositSenior : m.depositJunior)(new BN(units * D))
      .accountsPartial({ user: user.publicKey, config: p.config(), series: s.series, vault: s.vault, shareMint, userUnderlying: await ata(user, mint), userShares: await ata(user, shareMint) })
      .rpc();
  }

  const activate = (s: SeriesHandle, caller: Keypair) =>
    as(caller).vault.methods.activate()
      .accountsPartial({ caller: caller.publicKey, config: p.config(), series: s.series, riskEntry: s.risk, vault: s.vault, strategyPool: s.pool, poolVault: s.poolVault }).rpc();

  const simulateYield = (s: SeriesHandle, bps: number) =>
    A.mock.methods.simulateYield(bps).accountsPartial({ admin: admin.publicKey, pool: s.pool, poolVault: s.poolVault, reserve: s.reserve, sink: s.sink }).rpc();

  const claim = async (s: SeriesHandle, user: Keypair, tranche: "senior" | "junior"): Promise<string> => {
    const shareMint = tranche === "senior" ? s.seniorMint : s.juniorMint;
    const m = as(user).vault.methods;
    return (tranche === "senior" ? m.claimSenior : m.claimJunior)()
      .accountsPartial({ user: user.publicKey, series: s.series, vault: s.vault, shareMint, userShares: await ata(user, shareMint), userUnderlying: await ata(user, mint) }).rpc();
  };

  const settle = async (s: SeriesHandle, caller: Keypair): Promise<string> => {
    const pool = await accounts("mock").pool.fetch(s.pool);
    return as(caller).vault.methods.settle()
      .accountsPartial({ caller: caller.publicKey, series: s.series, vault: s.vault, strategyPool: s.pool, poolVault: pool.vault }).rpc();
  };

  const status = async (s: SeriesHandle) => statusName((await accounts("vault").series.fetch(s.series)).status);
  const waitUntil = async (unixSecs: number) => { while (Date.now() / 1000 < unixSecs + 2) await sleep(500); };

  return { conn, admin, riskAuth, keeper, alice, bob, carol, as, A, p, mint, ata, setRisk, createSeries, deposit, activate, simulateYield, claim, settle, status, waitUntil, accounts };
}
export type Chain = Awaited<ReturnType<typeof bootstrap>>;
