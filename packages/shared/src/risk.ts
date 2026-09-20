/** protocol_id is stored on-chain as 32 bytes: utf8, zero padded. */
export function protocolIdToBytes(id: string): Uint8Array {
  const raw = Buffer.from(id, "utf8");
  if (raw.length === 0 || raw.length > 32) throw new RangeError("protocol id must be 1-32 bytes");
  const out = new Uint8Array(32);
  out.set(raw);
  return out;
}

export function protocolIdFromBytes(bytes: ArrayLike<number>): string {
  return Buffer.from(Array.from(bytes)).toString("utf8").replace(/\0+$/, "");
}

/** Decimal fraction (0.052) to basis points (520), rounded and clamped to the given max. */
export function fractionToBps(x: number, max = 4_294_967_295): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(max, Math.round(x * 10_000)));
}
