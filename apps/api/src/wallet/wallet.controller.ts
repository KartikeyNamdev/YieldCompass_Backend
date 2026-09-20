import { BadRequestException, Body, Controller, HttpCode, Post } from "@nestjs/common";
import bs58 from "bs58";
import { DISCLAIMER } from "@yc/shared/dist/constants";
import { claimAmount } from "@yc/waterfall";
import { IsString, Length } from "class-validator";
import { fromBaseUnits } from "../lib/units";
import { SeriesRepo } from "../series/series.repo";

export class WalletBody {
  @IsString() @Length(32, 44) address: string;
}

/** A Solana address is 32 bytes of canonical base58. */
export function isSolanaAddress(s: string): boolean {
  try {
    const raw = bs58.decode(s);
    return raw.length === 32 && bs58.encode(raw) === s;
  } catch {
    return false;
  }
}

const WEEK_SECS = 7 * 86_400;

@Controller("v1/wallet")
export class WalletController {
  constructor(private series: SeriesRepo) {}

  /**
   * Vault positions for an address: what was advertised (senior target) versus what a settled series actually paid.
   * Only YieldCompass vault positions are read; positions in external protocols are phase 2.
   */
  @Post("positions")
  @HttpCode(200)
  async positions(@Body() body: WalletBody) {
    const owner = body.address;
    if (!isSolanaAddress(owner)) throw new BadRequestException("address is not a valid Solana public key");
    const rows = await this.series.positions(owner);
    const data = rows.map((p) => {
      const s = p.series;
      const fmt = (v: bigint) => fromBaseUnits(v, s.decimals);
      const settled = s.status === "settled";
      const trancheTotal = p.tranche === "senior" ? s.senior_principal : s.junior_principal;
      const payoutTotal = p.tranche === "senior" ? s.senior_payout : s.junior_payout;
      const payout = settled ? claimAmount(payoutTotal, p.principal, trancheTotal) : null;
      const periodReturn = payout !== null && p.principal > 0n ? Number(payout - p.principal) / Number(p.principal) : null;
      return {
        series_id: s.id,
        tranche: p.tranche,
        status: s.status,
        principal: fmt(p.principal),
        claimed: p.claimed,
        claimable: p.claimed ? "0" : settled ? fmt(payout ?? 0n) : s.status === "cancelled" ? fmt(p.principal) : "0", // refunds are 1:1
        advertised: p.tranche === "senior" ? { target_rate_bps: s.rate_bps, kind: "target, not guaranteed" } : { kind: "variable, first-loss" },
        realized: settled
          ? {
              payout: fmt(payout ?? 0n),
              period_return: periodReturn,
              // annualising a minutes-long demo term would be meaningless
              annualized: periodReturn !== null && s.term_secs >= WEEK_SECS ? Math.pow(1 + periodReturn, (365 * 86_400) / s.term_secs) - 1 : null,
            }
          : null,
        maturity_ts: s.maturity_ts?.toISOString() ?? null,
      };
    });
    const updated = rows.map((r) => r.series.updated_at.toISOString()).sort().at(-1) ?? null;
    return {
      address: owner,
      positions: data,
      notes: ["Only YieldCompass vault positions are shown. Positions in external protocols are not read yet."],
      disclaimer: DISCLAIMER,
      updated_at: updated,
    };
  }
}
