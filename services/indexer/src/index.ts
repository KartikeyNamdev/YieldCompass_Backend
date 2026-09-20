import { Connection, Keypair } from "@solana/web3.js";
import { resolve } from "path";
import { createPool, env, getPrograms, runMigrations, startHealthServer } from "@yc/shared";
import { Indexer } from "./indexer";

async function main() {
  const pool = createPool();
  await runMigrations(pool, process.env.MIGRATIONS_DIR ?? resolve(__dirname, "../../../migrations"));
  const state: Record<string, unknown> = { last_run: null, series: 0, last_error: null };
  startHealthServer("indexer", Number(process.env.PORT ?? 4002), () => state);

  const programs = getPrograms(new Connection(env("SOLANA_RPC_URL"), "confirmed"), Keypair.generate()); // read-only
  const indexer = new Indexer(pool, programs);
  const onError = (e: unknown) => {
    state.last_error = (e as Error).message;
    console.error("[indexer]", e);
  };
  const tick = async () => {
    try {
      const r = await indexer.runOnce();
      state.last_run = new Date().toISOString();
      state.series = r.series;
      state.last_error = null;
      if (r.applied > 0) console.log(`[indexer] applied ${r.applied} tx, ${r.series} series`);
    } catch (e) {
      onError(e);
    }
  };
  await tick();
  try {
    indexer.subscribe(onError);
  } catch (e) {
    onError(e); // polling below still keeps us correct
  }
  setInterval(tick, 10_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
