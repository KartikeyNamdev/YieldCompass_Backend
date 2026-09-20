import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  AccountLayout,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { BankrunProvider } from "anchor-bankrun";
import { expect } from "chai";
import { Clock, ProgramTestContext, startAnchor } from "solana-bankrun";
import { claimAmount, seniorOwed, simulate } from "@yc/waterfall";
import { readFileSync } from "fs";
import { join } from "path";

const loadIdl = (n: string) => JSON.parse(readFileSync(join(__dirname, "..", "target", "idl", `${n}.json`), "utf8"));
const ycIdl = loadIdl("yc_vault");
const myIdl = loadIdl("mock_yield");

const D = 1_000_000n; // 6 decimals
const T0 = 1_800_000_000; // fixed start time for deterministic tests

let ctx: ProgramTestContext;
let yc: Program<any>;
let my: Program<any>;
let nonce = 0;

const admin = Keypair.generate();
const riskAuth = Keypair.generate();
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate();
const mallory = Keypair.generate();
let mint: PublicKey;
let config: PublicKey;

// ------------------------------------------------------------------ helpers
const pda = (seeds: Buffer[], pid: PublicKey) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const protoId = (name: string) => {
  const b = Buffer.alloc(32);
  b.write(name);
  return b;
};

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 + nonce++ })); // makes every tx unique
  tx.add(...ixs);
  tx.recentBlockhash = (await ctx.banksClient.getLatestBlockhash())![0];
  tx.feePayer = ctx.payer.publicKey;
  const uniq = [ctx.payer, ...signers.filter((s) => !s.publicKey.equals(ctx.payer.publicKey))];
  tx.sign(...uniq);
  return ctx.banksClient.tryProcessTransaction(tx);
}
const ok = (res: any) => expect(res.result, (res.meta?.logMessages ?? []).join("\n")).to.equal(null);
const failsWith = (res: any, code: string) => {
  expect(res.result, "expected the transaction to fail").to.not.equal(null);
  expect((res.meta?.logMessages ?? []).join("\n")).to.include(`Error Code: ${code}`);
};

async function now(): Promise<number> {
  return Number((await ctx.banksClient.getClock()).unixTimestamp);
}
async function warpTo(ts: number) {
  const c = await ctx.banksClient.getClock();
  ctx.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(ts)));
}
async function bal(a: PublicKey): Promise<bigint> {
  const acc = await ctx.banksClient.getAccount(a);
  return acc ? AccountLayout.decode(Buffer.from(acc.data)).amount : 0n;
}
const ata = (m: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(m, owner, true);
const ataIx = (m: PublicKey, owner: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(ctx.payer.publicKey, ata(m, owner), owner, m);

async function createMint(): Promise<PublicKey> {
  const kp = Keypair.generate();
  const rent = await ctx.banksClient.getRent();
  const res = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(kp.publicKey, 6, ctx.payer.publicKey, null),
    ],
    [kp],
  );
  ok(res);
  return kp.publicKey;
}
async function mintTo(to: PublicKey, amount: bigint) {
  ok(await send([createMintToInstruction(mint, to, ctx.payer.publicKey, amount)]));
}
async function fundUser(kp: Keypair, usdc: bigint) {
  ok(
    await send([
      SystemProgram.transfer({ fromPubkey: ctx.payer.publicKey, toPubkey: kp.publicKey, lamports: 5_000_000_000 }),
      ataIx(mint, kp.publicKey),
      createMintToInstruction(mint, ata(mint, kp.publicKey), ctx.payer.publicKey, usdc),
    ]),
  );
}

interface SeriesOpts {
  id: number;
  deadlineIn?: number;
  term?: number;
  minScore?: number;
  riskScore?: number;
  riskTtl?: number;
  minJuniorBps?: number;
  reserve?: bigint;
}
interface S {
  id: number;
  series: PublicKey;
  vault: PublicKey;
  seniorMint: PublicKey;
  juniorMint: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
  reserve: PublicKey;
  sink: PublicKey;
  risk: PublicKey;
  proto: Buffer;
  deadline: number;
  term: number;
}

async function setRisk(proto: Buffer, score: number, ttl: number, signer = riskAuth) {
  const risk = pda([Buffer.from("risk"), proto], yc.programId);
  const t = await now();
  return send(
    [
      await yc.methods
        .setRiskEntry(Array.from(proto), score, 640, 1500, new BN(t + ttl))
        .accountsPartial({ authority: signer.publicKey, config, riskEntry: risk })
        .instruction(),
    ],
    [signer],
  );
}

async function makeSeries(o: SeriesOpts): Promise<S> {
  const proto = protoId(`proto-${o.id}`);
  ok(await setRisk(proto, o.riskScore ?? 80, o.riskTtl ?? 86_400));
  const t = await now();
  const series = pda([Buffer.from("series"), u64le(o.id)], yc.programId);
  const pool = pda([Buffer.from("pool"), series.toBuffer()], my.programId);
  const poolVault = pda([Buffer.from("pool_vault"), pool.toBuffer()], my.programId);
  const reserve = pda([Buffer.from("reserve"), pool.toBuffer()], my.programId);
  const sink = pda([Buffer.from("sink"), pool.toBuffer()], my.programId);
  ok(
    await send(
      [
        await my.methods
          .initPool(series)
          .accountsPartial({ admin: admin.publicKey, mint, pool, poolVault, reserve, sink })
          .instruction(),
      ],
      [admin],
    ),
  );
  await mintTo(reserve, o.reserve ?? 50n * D);

  const risk = pda([Buffer.from("risk"), proto], yc.programId);
  const s: S = {
    id: o.id,
    series,
    vault: pda([Buffer.from("vault"), series.toBuffer()], yc.programId),
    seniorMint: pda([Buffer.from("senior_mint"), series.toBuffer()], yc.programId),
    juniorMint: pda([Buffer.from("junior_mint"), series.toBuffer()], yc.programId),
    pool,
    poolVault,
    reserve,
    sink,
    risk,
    proto,
    deadline: t + (o.deadlineIn ?? 60),
    term: o.term ?? 180,
  };
  const res = await initSeries(s, o, admin);
  ok(res);
  return s;
}
async function initSeries(s: S, o: SeriesOpts, signer: Keypair) {
  return send(
    [
      await yc.methods
        .initSeries({
          id: new BN(o.id),
          rateBps: 200,
          termSecs: new BN(s.term),
          depositDeadline: new BN(s.deadline),
          minJuniorBps: o.minJuniorBps ?? 1000,
          minRiskScore: o.minScore ?? 60,
          performanceFeeBps: 0,
        })
        .accountsPartial({
          admin: signer.publicKey,
          config,
          underlyingMint: mint,
          series: s.series,
          vault: s.vault,
          seniorMint: s.seniorMint,
          juniorMint: s.juniorMint,
          strategyPool: s.pool,
          riskEntry: s.risk,
        })
        .instruction(),
    ],
    [signer],
  );
}

async function deposit(s: S, user: Keypair, tranche: "senior" | "junior", amount: bigint) {
  const shareMint = tranche === "senior" ? s.seniorMint : s.juniorMint;
  const m = tranche === "senior" ? yc.methods.depositSenior : yc.methods.depositJunior;
  return send(
    [
      ataIx(shareMint, user.publicKey),
      await m(new BN(amount.toString()))
        .accountsPartial({
          user: user.publicKey,
          config,
          series: s.series,
          vault: s.vault,
          shareMint,
          userUnderlying: ata(mint, user.publicKey),
          userShares: ata(shareMint, user.publicKey),
        })
        .instruction(),
    ],
    [user],
  );
}
const activate = async (s: S, caller = mallory) =>
  send(
    [
      await yc.methods
        .activate()
        .accountsPartial({
          caller: caller.publicKey,
          config,
          series: s.series,
          riskEntry: s.risk,
          vault: s.vault,
          strategyPool: s.pool,
          poolVault: s.poolVault,
        })
        .instruction(),
    ],
    [caller],
  );
const settle = async (s: S, caller = mallory) =>
  send(
    [
      await yc.methods
        .settle()
        .accountsPartial({
          caller: caller.publicKey,
          series: s.series,
          vault: s.vault,
          strategyPool: s.pool,
          poolVault: s.poolVault,
        })
        .instruction(),
    ],
    [caller],
  );
const cancel = async (s: S, caller = mallory) =>
  send(
    [
      await yc.methods
        .cancelSeries()
        .accountsPartial({ caller: caller.publicKey, config, series: s.series, riskEntry: s.risk })
        .instruction(),
    ],
    [caller],
  );
const refund = async (s: S, user: Keypair) =>
  send(
    [
      ataIx(s.seniorMint, user.publicKey),
      ataIx(s.juniorMint, user.publicKey),
      await yc.methods
        .refund()
        .accountsPartial({
          user: user.publicKey,
          series: s.series,
          vault: s.vault,
          seniorMint: s.seniorMint,
          juniorMint: s.juniorMint,
          userSenior: ata(s.seniorMint, user.publicKey),
          userJunior: ata(s.juniorMint, user.publicKey),
          userUnderlying: ata(mint, user.publicKey),
        })
        .instruction(),
    ],
    [user],
  );
const claim = async (s: S, user: Keypair, tranche: "senior" | "junior") => {
  const shareMint = tranche === "senior" ? s.seniorMint : s.juniorMint;
  const m = tranche === "senior" ? yc.methods.claimSenior : yc.methods.claimJunior;
  return send(
    [
      await m()
        .accountsPartial({
          user: user.publicKey,
          series: s.series,
          vault: s.vault,
          shareMint,
          userShares: ata(shareMint, user.publicKey),
          userUnderlying: ata(mint, user.publicKey),
        })
        .instruction(),
    ],
    [user],
  );
};
const simulateMock = async (s: S, kind: "yield" | "loss", bps: number, signer = admin) => {
  const m = kind === "yield" ? my.methods.simulateYield : my.methods.simulateLoss;
  return send(
    [
      await m(bps)
        .accountsPartial({ admin: signer.publicKey, pool: s.pool, poolVault: s.poolVault, reserve: s.reserve, sink: s.sink })
        .instruction(),
    ],
    [signer],
  );
};
const setPaused = async (paused: boolean, signer = admin) =>
  send([await yc.methods.setPaused(paused).accountsPartial({ admin: signer.publicKey, config }).instruction()], [signer]);

const fetchSeries = (s: S) => (yc.account as any).series.fetch(s.series);

// ------------------------------------------------------------------ suite
describe("yc_vault + mock_yield", () => {
  before(async () => {
    ctx = await startAnchor(".", [], []);
    const provider = new BankrunProvider(ctx);
    anchor.setProvider(provider);
    yc = new Program(ycIdl as anchor.Idl, provider);
    my = new Program(myIdl as anchor.Idl, provider);
    await warpTo(T0);
    mint = await createMint();
    for (const [kp, amt] of [[alice, 1000n], [bob, 1000n], [carol, 1000n], [mallory, 1000n], [admin, 0n], [riskAuth, 0n]] as const) {
      await fundUser(kp, amt * D);
    }
    config = pda([Buffer.from("config")], yc.programId);
    ok(
      await send([
        await yc.methods.initConfig(admin.publicKey, riskAuth.publicKey).accountsPartial({ payer: ctx.payer.publicKey, config }).instruction(),
      ]),
    );
  });

  it("invariant 3: no instruction exposes an admin withdraw path", () => {
    const names = (ycIdl as any).instructions.map((i: any) => i.name).sort();
    expect(names).to.deep.equal(
      ["activate", "cancel_series", "claim_junior", "claim_senior", "deposit_junior", "deposit_senior", "init_config", "init_series", "refund", "set_paused", "set_risk_entry", "settle"].sort(),
    );
  });

  it("rejects unauthorized set_risk_entry / init_series / set_paused", async () => {
    failsWith(await setRisk(protoId("evil"), 100, 1000, mallory), "Unauthorized");
    failsWith(await setPaused(true, mallory), "Unauthorized");
    // init_series signed by mallory (pool + risk entry prepared legitimately)
    const proto = protoId("proto-30");
    ok(await setRisk(proto, 80, 86_400));
    const series = pda([Buffer.from("series"), u64le(30)], yc.programId);
    const pool = pda([Buffer.from("pool"), series.toBuffer()], my.programId);
    ok(
      await send(
        [
          await my.methods
            .initPool(series)
            .accountsPartial({
              admin: admin.publicKey,
              mint,
              pool,
              poolVault: pda([Buffer.from("pool_vault"), pool.toBuffer()], my.programId),
              reserve: pda([Buffer.from("reserve"), pool.toBuffer()], my.programId),
              sink: pda([Buffer.from("sink"), pool.toBuffer()], my.programId),
            })
            .instruction(),
        ],
        [admin],
      ),
    );
    const s: S = {
      id: 30, series, pool, proto, term: 180, deadline: (await now()) + 60,
      vault: pda([Buffer.from("vault"), series.toBuffer()], yc.programId),
      seniorMint: pda([Buffer.from("senior_mint"), series.toBuffer()], yc.programId),
      juniorMint: pda([Buffer.from("junior_mint"), series.toBuffer()], yc.programId),
      poolVault: PublicKey.default, reserve: PublicKey.default, sink: PublicKey.default,
      risk: pda([Buffer.from("risk"), proto], yc.programId),
    };
    failsWith(await initSeries(s, { id: 30 }, mallory), "Unauthorized");
  });

  it("validates init_series params", async () => {
    // min_junior_bps out of range (below 500)
    const proto = protoId("proto-31");
    ok(await setRisk(proto, 80, 86_400));
    const series = pda([Buffer.from("series"), u64le(31)], yc.programId);
    const pool = pda([Buffer.from("pool"), series.toBuffer()], my.programId);
    ok(
      await send(
        [
          await my.methods
            .initPool(series)
            .accountsPartial({
              admin: admin.publicKey, mint, pool,
              poolVault: pda([Buffer.from("pool_vault"), pool.toBuffer()], my.programId),
              reserve: pda([Buffer.from("reserve"), pool.toBuffer()], my.programId),
              sink: pda([Buffer.from("sink"), pool.toBuffer()], my.programId),
            })
            .instruction(),
        ],
        [admin],
      ),
    );
    const s: S = {
      id: 31, series, pool, proto, term: 180, deadline: (await now()) + 60,
      vault: pda([Buffer.from("vault"), series.toBuffer()], yc.programId),
      seniorMint: pda([Buffer.from("senior_mint"), series.toBuffer()], yc.programId),
      juniorMint: pda([Buffer.from("junior_mint"), series.toBuffer()], yc.programId),
      poolVault: PublicKey.default, reserve: PublicKey.default, sink: PublicKey.default,
      risk: pda([Buffer.from("risk"), proto], yc.programId),
    };
    failsWith(await initSeries(s, { id: 31, minJuniorBps: 100 }, admin), "InvalidParams");
    failsWith(await initSeries(s, { id: 31, minJuniorBps: 6000 }, admin), "InvalidParams");
  });

  it("capacity rule: senior deposit rejected when it would break the junior buffer", async () => {
    const s = await makeSeries({ id: 10 });
    // no junior yet: any senior deposit breaks the 10% buffer
    failsWith(await deposit(s, alice, "senior", 10n * D), "JuniorBufferTooSmall");
    ok(await deposit(s, bob, "junior", 10n * D));
    ok(await deposit(s, alice, "senior", 90n * D)); // exactly 9x
    failsWith(await deposit(s, alice, "senior", 1n), "JuniorBufferTooSmall");
    ok(await deposit(s, bob, "junior", 1n * D)); // more junior reopens capacity
    ok(await deposit(s, alice, "senior", 9n * D));
    const acc = await fetchSeries(s);
    expect(BigInt(acc.seniorPrincipal.toString())).to.equal(99n * D);
    expect(BigInt(acc.juniorPrincipal.toString())).to.equal(11n * D);
  });

  it("window rules: no cancel or activate before deadline; no deposit after", async () => {
    const s = await makeSeries({ id: 14, deadlineIn: 60 });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    failsWith(await activate(s), "DepositWindowOpen");
    failsWith(await cancel(s), "DepositWindowOpen");
    await warpTo(s.deadline + 1);
    failsWith(await deposit(s, alice, "senior", 1n * D), "DepositWindowClosed");
    failsWith(await cancel(s), "ActivationConditionsMet"); // healthy series cannot be cancelled
  });

  it("risk gate: stale entry blocks activate, refresh unblocks it", async () => {
    const s = await makeSeries({ id: 13, deadlineIn: 50, riskTtl: 60 });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    await warpTo(s.deadline + 30); // past both deadline (50s) and expiry (60s)
    failsWith(await activate(s), "RiskEntryStale");
    ok(await setRisk(s.proto, 80, 86_400)); // keeper refreshes the entry
    ok(await activate(s));
    expect((await fetchSeries(s)).status).to.have.property("active");
  });

  it("risk gate: low score blocks activate", async () => {
    const s = await makeSeries({ id: 12, riskScore: 40, minScore: 60 });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    await warpTo(s.deadline + 1);
    failsWith(await activate(s), "RiskScoreTooLow");
  });

  it("cancel + refund returns principal 1:1, and refund works while paused", async () => {
    const s = await makeSeries({ id: 11, deadlineIn: 50, riskTtl: 60 });
    const aBefore = await bal(ata(mint, alice.publicKey));
    const bBefore = await bal(ata(mint, bob.publicKey));
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    failsWith(await refund(s, alice), "WrongStatus"); // not cancelled yet
    await warpTo(s.deadline + 30); // entry expired
    ok(await cancel(s));
    expect((await fetchSeries(s)).status).to.have.property("cancelled");

    ok(await setPaused(true));
    ok(await refund(s, alice));
    ok(await refund(s, bob));
    ok(await setPaused(false));
    expect(await bal(ata(mint, alice.publicKey))).to.equal(aBefore);
    expect(await bal(ata(mint, bob.publicKey))).to.equal(bBefore);
    expect(await bal(s.vault)).to.equal(0n);
    failsWith(await refund(s, alice), "NothingToClaim");
  });

  it("pause blocks deposit and activate", async () => {
    const s = await makeSeries({ id: 15, deadlineIn: 60 });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    ok(await setPaused(true));
    failsWith(await deposit(s, alice, "senior", 1n * D), "Paused");
    await warpTo(s.deadline + 1);
    failsWith(await activate(s), "Paused");
    ok(await setPaused(false));
    ok(await activate(s));
  });

  it("full lifecycle: activate, simulate_yield, settle by anyone, pro-rata claims, double-claim rejected", async () => {
    const s = await makeSeries({ id: 20, deadlineIn: 60, term: 180 });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 60n * D));
    ok(await deposit(s, carol, "senior", 40n * D + 7n)); // odd amount so pro-rata rounds
    await warpTo(s.deadline);
    ok(await activate(s));
    const active = await fetchSeries(s);
    expect(Number(active.maturityTs)).to.equal(Number(active.startTs) + 180);
    const seniorP = 100n * D + 7n;
    const juniorP = 20n * D;
    expect(await bal(s.vault)).to.equal(0n);
    expect(await bal(s.poolVault)).to.equal(seniorP + juniorP);

    failsWith(await settle(s), "NotMatured");
    failsWith(await claim(s, alice, "senior"), "WrongStatus");

    ok(await simulateMock(s, "yield", 600));
    await warpTo(Number(active.maturityTs));
    ok(await settle(s, mallory)); // anyone can settle

    const sim = simulate({ seniorPrincipal: seniorP, juniorPrincipal: juniorP, rateBps: 200, termSecs: 180n, yieldBps: 600 });
    const st = await fetchSeries(s);
    expect(st.status).to.have.property("settled");
    expect(BigInt(st.seniorPayout.toString())).to.equal(sim.seniorPayout);
    expect(BigInt(st.juniorPayout.toString())).to.equal(sim.juniorPayout);
    expect(sim.seniorPayout).to.equal(seniorOwed(seniorP, 200, 180n)); // 6% > target, so senior gets exactly the target
    expect(await bal(s.vault)).to.equal(sim.totalAssets);

    const a0 = await bal(ata(mint, alice.publicKey));
    const c0 = await bal(ata(mint, carol.publicKey));
    const b0 = await bal(ata(mint, bob.publicKey));
    ok(await claim(s, alice, "senior"));
    ok(await claim(s, carol, "senior"));
    ok(await claim(s, bob, "junior"));
    const aGot = (await bal(ata(mint, alice.publicKey))) - a0;
    const cGot = (await bal(ata(mint, carol.publicKey))) - c0;
    const bGot = (await bal(ata(mint, bob.publicKey))) - b0;
    expect(aGot).to.equal(claimAmount(sim.seniorPayout, 60n * D, seniorP));
    expect(cGot).to.equal(claimAmount(sim.seniorPayout, 40n * D + 7n, seniorP));
    expect(bGot).to.equal(sim.juniorPayout);
    expect(aGot + cGot <= sim.seniorPayout).to.equal(true); // invariant 4
    expect(await bal(s.vault)).to.equal(sim.totalAssets - aGot - cGot - bGot); // dust stays in the vault

    // claims still work while paused, and a second claim is rejected
    ok(await setPaused(true));
    failsWith(await claim(s, alice, "senior"), "NothingToClaim");
    ok(await setPaused(false));
  });

  it("claim works while paused", async () => {
    const s = await makeSeries({ id: 41, deadlineIn: 60, term: 60 });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    await warpTo(s.deadline);
    ok(await activate(s));
    const st = await fetchSeries(s);
    await warpTo(Number(st.maturityTs));
    ok(await settle(s));
    ok(await setPaused(true));
    ok(await claim(s, alice, "senior"));
    ok(await claim(s, bob, "junior"));
    ok(await setPaused(false));
  });

  it("loss path: senior falls below target only after junior is wiped", async () => {
    // -10%: junior absorbs it, senior still gets the full target
    const a = await makeSeries({ id: 21, deadlineIn: 60, term: 180 });
    ok(await deposit(a, bob, "junior", 20n * D));
    ok(await deposit(a, alice, "senior", 100n * D));
    await warpTo(a.deadline);
    ok(await activate(a));
    ok(await simulateMock(a, "loss", 1000));
    await warpTo(Number((await fetchSeries(a)).maturityTs));
    ok(await settle(a));
    let sim = simulate({ seniorPrincipal: 100n * D, juniorPrincipal: 20n * D, rateBps: 200, termSecs: 180n, yieldBps: -1000 });
    let st = await fetchSeries(a);
    expect(BigInt(st.seniorPayout.toString())).to.equal(sim.seniorOwed);
    expect(BigInt(st.juniorPayout.toString())).to.equal(sim.juniorPayout);
    expect(sim.juniorPayout > 0n).to.equal(true);

    // -20%: junior is wiped out and senior takes a loss
    const b = await makeSeries({ id: 22, deadlineIn: 60, term: 180 });
    ok(await deposit(b, bob, "junior", 20n * D));
    ok(await deposit(b, alice, "senior", 100n * D));
    await warpTo(b.deadline);
    ok(await activate(b));
    ok(await simulateMock(b, "loss", 2000));
    await warpTo(Number((await fetchSeries(b)).maturityTs));
    ok(await settle(b));
    sim = simulate({ seniorPrincipal: 100n * D, juniorPrincipal: 20n * D, rateBps: 200, termSecs: 180n, yieldBps: -2000 });
    st = await fetchSeries(b);
    expect(BigInt(st.juniorPayout.toString())).to.equal(0n);
    expect(BigInt(st.seniorPayout.toString())).to.equal(sim.seniorPayout);
    expect(sim.seniorShortfall).to.equal(true);
    expect(BigInt(st.seniorPayout.toString()) < sim.seniorOwed).to.equal(true);
  });

  it("mock_yield: only its admin can simulate; reserve must cover yield", async () => {
    const s = await makeSeries({ id: 50, deadlineIn: 60, reserve: 1n * D });
    ok(await deposit(s, bob, "junior", 20n * D));
    ok(await deposit(s, alice, "senior", 100n * D));
    await warpTo(s.deadline);
    ok(await activate(s));
    failsWith(await simulateMock(s, "yield", 100, mallory), "Unauthorized");
    failsWith(await simulateMock(s, "yield", 600), "InsufficientReserve"); // 7.2 USDC needed, 1 in reserve
  });
});
