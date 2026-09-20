import { BadRequestException, Body, Controller, HttpCode, HttpException, Post, ServiceUnavailableException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { normalizeUrl } from "@yc/shared/dist/health";
import { isSolanaAddress, WalletBody } from "../wallet/wallet.controller";

/**
 * Devnet test-token faucet. The API holds no keys: it validates the address and forwards to the keeper,
 * which owns the mint authority, the per-address cooldown and the SOL drip.
 */
@Controller("v1/faucet")
export class FaucetController {
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: Number(process.env.FAUCET_RATE_PER_MIN ?? 5), ttl: 60_000 } })
  async drip(@Body() body: WalletBody) {
    if (!isSolanaAddress(body.address)) throw new BadRequestException("address is not a valid Solana public key");
    const base = normalizeUrl(process.env.KEEPER_URL ?? "http://keeper:4003");
    let res: Response;
    try {
      res = await fetch(`${base}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: body.address }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ServiceUnavailableException("faucet is unavailable");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ...json, disclaimer: "Devnet test tokens only. No value." };
    if (res.status === 429) throw new HttpException({ statusCode: 429, message: json.error ?? "faucet cooldown", retry_after_secs: json.retry_after_secs }, 429);
    if (res.status === 400) throw new BadRequestException(json.error ?? "bad request");
    throw new ServiceUnavailableException("faucet is unavailable"); // includes 404 when the keeper has no faucet configured
  }
}
