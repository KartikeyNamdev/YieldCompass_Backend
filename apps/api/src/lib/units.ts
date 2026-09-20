import { BadRequestException } from "@nestjs/common";

/** "100.5" with 6 decimals -> 100_500_000n. Rejects negatives, zero, junk and excess precision. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const m = /^(\d{1,18})(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new BadRequestException("amount must be a positive decimal number");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new BadRequestException(`amount has more than ${decimals} decimal places`);
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (v <= 0n) throw new BadRequestException("amount must be greater than zero");
  if (v > (1n << 64n) - 1n) throw new BadRequestException("amount is too large");
  return v;
}

export function fromBaseUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
