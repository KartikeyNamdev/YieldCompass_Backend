/**
 * Demo CLI for the on-chain side (devnet or a local validator). DEVNET TEST TOKENS ONLY.
 *
 *   node dist/demo.js bootstrap                       create test mint + config + two risk entries (good / low score)
 *   node dist/demo.js create-series [--id 1] [--deadline 90] [--term 180] [--protocol demo-good] [--min-score 60] [--reserve 50]
 *   node dist/demo.js mint <wallet> <amount>          give test stablecoin to a wallet
 *   node dist/demo.js deposit <id> senior|junior <amount> [--keypair path]   deposit as a wallet (default: admin key)
 *   node dist/demo.js claim <id> senior|junior [--keypair path]   claim a settled payout
 *   node dist/demo.js activate <id>                   anyone may call after the deadline; the program enforces the risk gate
 *   node dist/demo.js simulate <id> yield|loss <bps>  mock_yield test double (admin only)
 *   node dist/demo.js status <id>
 *
 * Keys come from secrets/admin.json, secrets/risk.json, secrets/keeper.json (scripts/gen-devnet-keys.sh).
 */
import { BN } from "@coral-xyz/anchor";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { getPrograms, loadKeypair, pdas, protocolIdToBytes, statusName } from "@yc/shared";

const ROOT = resolve(__dirname, "../../..");
const STATE = resolve(ROOT, ".local/demo.json");
const D = 1_000_000;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const key = (n: string) => loadKeypair(process.env[`${n.toUpperCase()}_KEYPAIR_PATH`] ?? resolve(ROOT, `secrets/${n}.json`));
// one saved mint per RPC endpoint, so a local-validator mint is never reused on devnet
const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const readAll = (): Record<string, { mint?: string }> => {
  if (!existsSync(STATE)) return {};
  const raw = JSON.parse(readFileSync(STATE, "utf8"));
  return raw.mint ? {} : raw; // ignore the old single-mint format
};
const loadState = (): { mint?: string } => readAll()[RPC_URL] ?? {};
const saveState = (s: { mint?: string }) => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ...readAll(), [RPC_URL]: s }, null, 2));
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--") || true);
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? "http://localhost:8899", "confirmed");
  const admin = key("admin"), riskAuth = key("risk"), keeper = key("keeper");
  const A = getPrograms(conn, admin), R = getPrograms(conn, riskAuth), K = getPrograms(conn, keeper);
  const p = pdas(A.vault.programId);
  const acct = (prog: typeof A.vault) => prog.account as any;
  const sub = (tag: string, base: PublicKey, prog: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), base.toBuffer()], prog)[0];
  const mintOf = () => {
    const m = loadState().mint;
    if (!m) throw new Error("run `bootstrap` first");
    return new PublicKey(m);
  };
  const setRisk = async (protocol: string, score: number, ttlSecs: number) => {
    const id = protocolIdToBytes(protocol);
    await R.vault.methods.setRiskEntry(Array.from(id), score, 590, 2000, new BN(Math.floor(Date.now() / 1000) + ttlSecs))
      .accountsPartial({ authority: riskAuth.publicKey, config: p.config(), riskEntry: p.risk(id) }).rpc();
    console.log(`risk entry ${protocol}: score ${score}, expires in ${ttlSecs}s`);
  };

  switch (cmd) {
    case "bootstrap": {
      const mint = loadState().mint ? mintOf() : await createMint(conn, admin, admin.publicKey, null, 6);
      saveState({ mint: mint.toBase58() });
      if (!(await conn.getAccountInfo(p.config()))) {
        await A.vault.methods.initConfig(admin.publicKey, riskAuth.publicKey).accountsPartial({ payer: admin.publicKey, config: p.config() }).rpc();
        console.log("config initialised");
      }
      await setRisk("demo-good", 85, 86_400);
      await setRisk("demo-low", 40, 86_400);
      console.log(`test mint: ${mint.toBase58()}\nadmin: ${admin.publicKey}\nrisk authority: ${riskAuth.publicKey}\nkeeper: ${keeper.publicKey}`);
      break;
    }
    case "mint": {
      const [wallet, amount] = rest;
      const owner = new PublicKey(wallet);
      const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mintOf(), owner);
      await mintTo(conn, admin, mintOf(), ata.address, admin, BigInt(Math.round(Number(amount) * D)));
      console.log(`minted ${amount} test tokens to ${owner.toBase58()}`);
      break;
    }
    case "create-series": {
      const id = Number(arg("id", "1"));
      const protocol = arg("protocol", "demo-good");
      const deadline = Math.floor(Date.now() / 1000) + Number(arg("deadline", "90"));
      const series = p.series(id);
      const pool = sub("pool", series, A.mock.programId);
      const [poolVault, reserve, sink] = ["pool_vault", "reserve", "sink"].map((t) => sub(t, pool, A.mock.programId));
      const mint = mintOf();
      await A.mock.methods.initPool(series).accountsPartial({ admin: admin.publicKey, mint, pool, poolVault, reserve, sink }).rpc();
      await mintTo(conn, admin, mint, reserve, admin, BigInt(Math.round(Number(arg("reserve", "50")) * D)));
      await A.vault.methods
        .initSeries({ id: new BN(id), rateBps: Number(arg("rate-bps", "200")), termSecs: new BN(Number(arg("term", "180"))), depositDeadline: new BN(deadline),
          minJuniorBps: 1000, minRiskScore: Number(arg("min-score", "60")), performanceFeeBps: 0 })
        .accountsPartial({
          admin: admin.publicKey, config: p.config(), underlyingMint: mint, series, vault: sub("vault", series, A.vault.programId),
          seniorMint: sub("senior_mint", series, A.vault.programId), juniorMint: sub("junior_mint", series, A.vault.programId),
          strategyPool: pool, riskEntry: p.risk(protocolIdToBytes(protocol)),
        }).rpc();
      console.log(`series ${id} created (${series.toBase58()}), deposits close ${new Date(deadline * 1000).toISOString()}, gate: ${protocol} >= ${arg("min-score", "60")}`);
      break;
    }
    case "deposit": {
      const [id, tranche, amount] = rest;
      const user = arg("keypair", "") ? loadKeypair(arg("keypair", "")) : admin;
      const P = getPrograms(conn, user);
      const s = p.series(Number(id));
      const a = await acct(A.vault).series.fetch(s);
      const shareMint = tranche === "senior" ? a.seniorMint : a.juniorMint;
      const underlying = (await getOrCreateAssociatedTokenAccount(conn, user, mintOf(), user.publicKey)).address;
      const shares = (await getOrCreateAssociatedTokenAccount(conn, user, shareMint, user.publicKey)).address;
      const m = tranche === "senior" ? P.vault.methods.depositSenior : P.vault.methods.depositJunior;
      await m(new BN(Math.round(Number(amount) * D)))
        .accountsPartial({ user: user.publicKey, config: p.config(), series: s, vault: a.vault, shareMint, userUnderlying: underlying, userShares: shares }).rpc();
      console.log(`deposited ${amount} as ${tranche} from ${user.publicKey.toBase58()}`);
      break;
    }
    case "claim": {
      const [id, tranche] = rest;
      const user = arg("keypair", "") ? loadKeypair(arg("keypair", "")) : admin;
      const P = getPrograms(conn, user);
      const s = p.series(Number(id));
      const a = await acct(A.vault).series.fetch(s);
      const shareMint = tranche === "senior" ? a.seniorMint : a.juniorMint;
      const underlying = (await getOrCreateAssociatedTokenAccount(conn, user, mintOf(), user.publicKey)).address;
      const shares = (await getOrCreateAssociatedTokenAccount(conn, user, shareMint, user.publicKey)).address;
      const m = tranche === "senior" ? P.vault.methods.claimSenior : P.vault.methods.claimJunior;
      await m().accountsPartial({ user: user.publicKey, series: s, vault: a.vault, shareMint, userShares: shares, userUnderlying: underlying }).rpc();
      console.log(`claimed ${tranche} payout for series ${id}`);
      break;
    }
    case "activate": {
      const s = p.series(Number(rest[0]));
      const a = await acct(A.vault).series.fetch(s);
      const pool = await acct(A.mock).pool.fetch(a.strategyPool);
      try {
        const sig = await K.vault.methods.activate()
          .accountsPartial({ caller: keeper.publicKey, config: p.config(), series: s, riskEntry: a.riskEntry, vault: a.vault, strategyPool: a.strategyPool, poolVault: pool.vault }).rpc();
        console.log(`activated: ${sig}`);
      } catch (e) {
        const code = /Error Code: (\w+)/.exec(((e as any).logs ?? []).join("\n") + (e as Error).message)?.[1];
        console.log(`REFUSED by the program${code ? `: ${code}` : ""}`);
        process.exitCode = 2;
      }
      break;
    }
    case "simulate": {
      const [id, kind, bps] = rest;
      const s = p.series(Number(id));
      const a = await acct(A.vault).series.fetch(s);
      const pool = await acct(A.mock).pool.fetch(a.strategyPool);
      const m = kind === "loss" ? A.mock.methods.simulateLoss : A.mock.methods.simulateYield;
      await m(Number(bps)).accountsPartial({ admin: admin.publicKey, pool: a.strategyPool, poolVault: pool.vault, reserve: pool.reserve, sink: pool.sink }).rpc();
      console.log(`simulated ${kind} ${bps} bps`);
      break;
    }
    case "status": {
      const a = await acct(A.vault).series.fetch(p.series(Number(rest[0])));
      const f = (n: BN) => Number(n.toString()) / D;
      console.log({ status: statusName(a.status), senior: f(a.seniorPrincipal), junior: f(a.juniorPrincipal), seniorPayout: f(a.seniorPayout), juniorPayout: f(a.juniorPayout), maturity: a.maturityTs.toNumber() ? new Date(a.maturityTs.toNumber() * 1000).toISOString() : null });
      break;
    }
    default:
      console.log("commands: bootstrap | mint <wallet> <amt> | create-series | deposit <id> senior|junior <amt> | claim <id> senior|junior | activate <id> | simulate <id> yield|loss <bps> | status <id>");
  }
}

main().catch((e) => {
  const logs: string[] = (e as { transactionLogs?: string[]; logs?: string[] }).transactionLogs ?? (e as { logs?: string[] }).logs ?? [];
  const code = /Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n]*)/.exec(logs.join("\n"));
  const tokenErr = logs.find((l) => l.includes("Error:") && !l.includes("Anchor"));
  console.error(code ? `Program error ${code[1]}: ${code[2]}` : tokenErr ?? (e as Error).message.split("\n")[0]);
  process.exit(1);
});
