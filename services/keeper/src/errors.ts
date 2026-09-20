/** Extract an Anchor error code name (e.g. "NotMatured") from a thrown web3/anchor error, if any. */
export function anchorErrorCode(e: unknown): string | undefined {
  const anyE = e as { error?: { errorCode?: { code?: string } }; logs?: string[]; message?: string };
  if (anyE?.error?.errorCode?.code) return anyE.error.errorCode.code;
  const hay = [...(anyE?.logs ?? []), anyE?.message ?? ""].join("\n");
  return /Error Code: (\w+)/.exec(hay)?.[1];
}
