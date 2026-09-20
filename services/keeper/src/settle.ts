import { Keypair } from "@solana/web3.js";
import { statusName } from "@yc/shared";
import type { Db, Programs } from "@yc/shared";
import { anchorErrorCode } from "./errors";
import * as tx from "./idempotency";

export interface SettleDeps {
  db: Db;
  programs: Programs; // provider wallet = keeper (any funded key works: settle is permissionless)
  keeper: Keypair;
  now: () => Date;
}

export interface SettleReport {
  scanned: number;
  settled: string[];
  notDue: string[];
  alreadySettled: string[];
  failed: Array<{ series: string; error: string }>;
}

/** Find matured Active series and call settle(). Safe to run concurrently and repeatedly. */
export async function settleMatured(d: SettleDeps): Promise<SettleReport> {
  const report: SettleReport = { scanned: 0, settled: [], notDue: [], alreadySettled: [], failed: [] };
  const all = await (d.programs.vault.account as any).series.all();
  const nowSecs = Math.floor(d.now().getTime() / 1000);

  for (const { publicKey, account } of all) {
    report.scanned++;
    if (statusName(account.status) !== "active") continue;
    const maturity = (account.maturityTs as { toNumber(): number }).toNumber();
    const name = publicKey.toBase58();
    if (maturity > nowSecs) {
      report.notDue.push(name);
      continue;
    }
    const key = `settle-${name}`;
    if (!(await tx.claim(d.db, key, "settle"))) continue;
    try {
      const pool = await (d.programs.mock.account as any).pool.fetch(account.strategyPool);
      const signature: string = await d.programs.vault.methods
        .settle()
        .accountsPartial({
          caller: d.keeper.publicKey,
          series: publicKey,
          vault: account.vault,
          strategyPool: account.strategyPool,
          poolVault: pool.vault,
        })
        .signers([d.keeper])
        .rpc();
      await tx.confirm(d.db, key, signature, { series: name });
      report.settled.push(name);
    } catch (e) {
      const code = anchorErrorCode(e);
      if (code === "WrongStatus") {
        await tx.confirm(d.db, key, null, { note: "already settled by someone else" });
        report.alreadySettled.push(name);
      } else if (code === "NotMatured") {
        await tx.release(d.db, key); // local clock ran ahead of the chain clock; try again next tick
        report.notDue.push(name);
      } else {
        await tx.fail(d.db, key, (e as Error).message);
        report.failed.push({ series: name, error: (e as Error).message });
      }
    }
  }
  return report;
}
