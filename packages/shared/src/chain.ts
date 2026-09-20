import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "fs";
import mockYieldIdl from "./idl/mock_yield.json";
import ycVaultIdl from "./idl/yc_vault.json";

export { ycVaultIdl, mockYieldIdl };

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/**
 * Load a keypair from an env var holding the JSON byte array (for hosts without secret files),
 * else from a file. Returns null if neither is available. DEVNET KEYS ONLY.
 */
export function keypairFromEnvOrFile(jsonVar: string, filePath?: string): Keypair | null {
  const json = process.env[jsonVar];
  if (json) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));
  return filePath && existsSync(filePath) ? loadKeypair(filePath) : null;
}

export interface Programs {
  connection: Connection;
  provider: AnchorProvider;
  vault: Program<any>;
  mock: Program<any>;
}

/** Build Program clients. IDL addresses can be overridden with YC_VAULT_PROGRAM_ID / MOCK_YIELD_PROGRAM_ID. */
export function getPrograms(connection: Connection, signer: Keypair): Programs {
  const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
  const withAddress = (idl: unknown, override?: string) =>
    (override ? { ...(idl as object), address: new PublicKey(override).toBase58() } : idl) as Idl;
  return {
    connection,
    provider,
    vault: new Program(withAddress(ycVaultIdl, process.env.YC_VAULT_PROGRAM_ID), provider),
    mock: new Program(withAddress(mockYieldIdl, process.env.MOCK_YIELD_PROGRAM_ID), provider),
  };
}

const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export const pdas = (vaultProgram: PublicKey) => ({
  config: () => PublicKey.findProgramAddressSync([Buffer.from("config")], vaultProgram)[0],
  risk: (protocol: Uint8Array) => PublicKey.findProgramAddressSync([Buffer.from("risk"), Buffer.from(protocol)], vaultProgram)[0],
  series: (id: number | bigint) => PublicKey.findProgramAddressSync([Buffer.from("series"), u64le(id)], vaultProgram)[0],
});

export type SeriesStatus = "open" | "active" | "settled" | "cancelled";

/** Anchor decodes enums as { open: {} }; return the variant name. */
export function statusName(status: Record<string, unknown>): SeriesStatus {
  return Object.keys(status)[0].toLowerCase() as SeriesStatus;
}
