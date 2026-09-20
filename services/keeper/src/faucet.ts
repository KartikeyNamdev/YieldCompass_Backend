import { IncomingMessage, ServerResponse } from "http";
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Db } from "@yc/shared";

/** Test-token faucet. DEVNET ONLY: mints the demo stablecoin (the authority key is a devnet test key). */
export interface FaucetDeps {
  db: Db;
  conn: Connection;
  payer: Keypair; // pays rent and gas, and drips the SOL
  authority: Keypair; // mint authority of the test stablecoin
  mint: PublicKey;
  tokens: number; // whole tokens per drip
  solDrip: number; // SOL sent when the recipient is nearly empty
  cooldownSecs: number;
  decimals?: number;
}

export class FaucetError extends Error {
  constructor(public status: number, message: string, public retryAfterSecs?: number) {
    super(message);
  }
}

export function parseAddress(s: unknown): PublicKey {
  if (typeof s !== "string") throw new FaucetError(400, "address is required");
  try {
    const raw = bs58.decode(s);
    if (raw.length !== 32 || bs58.encode(raw) !== s) throw new Error();
    return new PublicKey(raw);
  } catch {
    throw new FaucetError(400, "address is not a valid Solana public key");
  }
}

const LOW_SOL = 0.03 * LAMPORTS_PER_SOL;

export async function drip(d: FaucetDeps, address: unknown) {
  const owner = parseAddress(address);
  const key = owner.toBase58();

  // atomic cooldown: the row is only updated when the previous drip is old enough
  const claim = await d.db.query(
    `INSERT INTO faucet_log (address) VALUES ($1)
     ON CONFLICT (address) DO UPDATE SET last_at = now(), drips = faucet_log.drips + 1
       WHERE faucet_log.last_at < now() - make_interval(secs => $2)
     RETURNING 1`,
    [key, d.cooldownSecs],
  );
  if ((claim.rowCount ?? 0) === 0) {
    const r = await d.db.query("SELECT extract(epoch FROM (last_at + make_interval(secs => $2) - now()))::int AS wait FROM faucet_log WHERE address=$1", [key, d.cooldownSecs]);
    throw new FaucetError(429, "faucet cooldown: try again later", Math.max(1, r.rows[0]?.wait ?? d.cooldownSecs));
  }

  try {
    const decimals = d.decimals ?? 6;
    const ata = getAssociatedTokenAddressSync(d.mint, owner, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(d.payer.publicKey, ata, owner, d.mint),
      createMintToInstruction(d.mint, ata, d.authority.publicKey, BigInt(d.tokens) * 10n ** BigInt(decimals)),
    );
    let solSent = 0;
    if (d.solDrip > 0 && (await d.conn.getBalance(owner)) < LOW_SOL) {
      tx.add(SystemProgram.transfer({ fromPubkey: d.payer.publicKey, toPubkey: owner, lamports: Math.round(d.solDrip * LAMPORTS_PER_SOL) }));
      solSent = d.solDrip;
    }
    const signers = d.authority.publicKey.equals(d.payer.publicKey) ? [d.payer] : [d.payer, d.authority];
    const signature = await sendAndConfirmTransaction(d.conn, tx, signers, { commitment: "confirmed" });
    return { signature, address: key, mint: d.mint.toBase58(), tokens: d.tokens, sol: solSent };
  } catch (e) {
    await d.db.query("DELETE FROM faucet_log WHERE address=$1", [key]).catch(() => undefined); // a failed drip must not burn the cooldown
    throw e;
  }
}

async function readJson(req: IncomingMessage, limit = 2048): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new FaucetError(413, "request too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new FaucetError(400, "body must be JSON");
  }
}

export function faucetRoute(d: FaucetDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.url !== "/faucet") return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return send(405, { error: "use POST" }), true;
    try {
      const body = (await readJson(req)) as { address?: unknown };
      send(200, await drip(d, body.address));
    } catch (e) {
      if (e instanceof FaucetError) send(e.status, { error: e.message, retry_after_secs: e.retryAfterSecs });
      else send(502, { error: "faucet transaction failed" });
    }
    return true;
  };
}
