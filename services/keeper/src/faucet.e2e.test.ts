/** Real local validator + Postgres (scripts/e2e-keeper.sh). Skipped otherwise. */
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";
import { runMigrations, startHealthServer } from "@yc/shared";
import { bootstrap } from "@yc/testkit";
import { AddressInfo } from "net";
import { resolve } from "path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { faucetRoute } from "./faucet";

const RPC = process.env.TEST_RPC_URL;
const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!RPC || !DB)("test-token faucet (local validator)", () => {
  it("mints tokens and a little SOL once per cooldown, over HTTP", async () => {
    const conn = new Connection(RPC!, "confirmed");
    const db = new Pool({ connectionString: DB });
    await runMigrations(db, resolve(__dirname, "../../../migrations"));
    await db.query("TRUNCATE faucet_log");
    const c = await bootstrap(conn, { initConfig: false });

    const server = startHealthServer("faucet-test", 0, () => ({}), faucetRoute({
      db, conn, payer: c.keeper, authority: c.admin, mint: c.mint, tokens: 1000, solDrip: 0.05, cooldownSecs: 3600,
    }));
    await new Promise((r) => server.once("listening", r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const post = (address: unknown) =>
      fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });

    const user = Keypair.generate().publicKey;
    const ok = await post(user.toBase58());
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ tokens: 1000, sol: 0.05, address: user.toBase58() });
    expect((await getAccount(conn, getAssociatedTokenAddressSync(c.mint, user))).amount).toBe(1_000_000_000n);
    expect(await conn.getBalance(user)).toBeGreaterThanOrEqual(0.05 * 1e9);

    const again = await post(user.toBase58());
    expect(again.status).toBe(429);
    expect((await again.json()).retry_after_secs).toBeGreaterThan(3000);
    expect((await getAccount(conn, getAssociatedTokenAddressSync(c.mint, user))).amount).toBe(1_000_000_000n); // unchanged

    for (const bad of ["", "not-a-key", 42, null]) expect((await post(bad)).status).toBe(400);
    expect((await fetch(`${base}/faucet`)).status).toBe(405);
    expect((await fetch(`${base}/health`)).status).toBe(200);

    server.close();
    await db.end();
  }, 90_000);
});
