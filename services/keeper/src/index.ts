import { Queue, Worker } from "bullmq";
import { Connection } from "@solana/web3.js";
import IORedis from "ioredis";
import { existsSync } from "fs";
import { resolve } from "path";
import {
  DEFAULT_JOB_OPTIONS, PublishRiskJob, QUEUES, createPool, env, getPrograms, loadKeypair, runMigrations, startHealthServer,
} from "@yc/shared";
import { dueForRefresh, publishRisk } from "./publishRisk";
import { settleMatured } from "./settle";

async function main() {
  const pool = createPool();
  await runMigrations(pool, process.env.MIGRATIONS_DIR ?? resolve(__dirname, "../../../migrations"));
  const state: Record<string, unknown> = { chain_enabled: false, last_settle_scan: null, last_settled: 0 };
  const health = startHealthServer("keeper", Number(process.env.PORT ?? 4003), () => state);

  const keeperPath = env("KEEPER_KEYPAIR_PATH", "/run/secrets/keeper.json");
  const riskPath = env("RISK_AUTHORITY_KEYPAIR_PATH", "/run/secrets/risk.json");
  if (!existsSync(keeperPath) || !existsSync(riskPath)) {
    // Keep the container healthy so `docker compose up` works out of the box; on-chain duties stay off.
    console.warn(`[keeper] devnet keypairs not found (${keeperPath}, ${riskPath}); on-chain duties disabled. Run scripts/gen-devnet-keys.sh`);
    return;
  }
  const keeper = loadKeypair(keeperPath);
  const riskAuthority = loadKeypair(riskPath);
  const connection = new Connection(env("SOLANA_RPC_URL"), "confirmed");
  const settlePrograms = getPrograms(connection, keeper);
  const riskPrograms = getPrograms(connection, riskAuthority);
  state.chain_enabled = true;
  state.keeper = keeper.publicKey.toBase58();
  state.risk_authority = riskAuthority.publicKey.toBase58();

  const redis = new IORedis(env("REDIS_URL"), { maxRetriesPerRequest: null });
  const publishQ = new Queue(QUEUES.publishRisk, { connection: redis, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  const settleQ = new Queue(QUEUES.settleSeries, { connection: redis, defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 3 } });
  const now = () => new Date();

  const publisher = new Worker(
    QUEUES.publishRisk,
    async (job) => {
      if (job.name === "refresh") {
        // hourly: re-publish entries that are missing or close to expiry, so the on-chain gate never sees a stale score
        const bucket = Math.floor(Date.now() / (3 * 3600_000));
        const due = await dueForRefresh(pool);
        for (const id of due) await publishQ.add("publish", { protocolId: id, score: 0, computedAt: "" }, { jobId: `refresh-${id}-${bucket}` });
        return { due };
      }
      const data = job.data as PublishRiskJob;
      return publishRisk({ db: pool, programs: riskPrograms, riskAuthority, now }, data.protocolId, job.id ?? `pub-${data.protocolId}`);
    },
    { connection: redis, concurrency: 1 },
  );
  const settler = new Worker(
    QUEUES.settleSeries,
    async () => {
      const r = await settleMatured({ db: pool, programs: settlePrograms, keeper, now });
      state.last_settle_scan = new Date().toISOString();
      state.last_settled = r.settled.length;
      return r;
    },
    { connection: redis, concurrency: 1 },
  );
  for (const w of [publisher, settler]) {
    w.on("failed", (j, err) => console.error(`[keeper] ${w.name} ${j?.id} failed: ${err.message}`));
    w.on("completed", (j, r) => {
      const changed = w === settler ? (r as { settled: string[] }).settled.length > 0 : true;
      if (changed) console.log(`[keeper] ${w.name} ${j.id} ok`, JSON.stringify(r));
    });
  }

  await settleQ.upsertJobScheduler("settle-every-30s", { every: 30_000 }, { name: "settle", data: {} });
  await publishQ.upsertJobScheduler("refresh-hourly", { every: 3600_000 }, { name: "refresh", data: {} });
  await publishQ.add("refresh", {}, { jobId: `refresh-boot-${Date.now()}` });
  console.log(`[keeper] ready: keeper=${keeper.publicKey.toBase58()} risk_authority=${riskAuthority.publicKey.toBase58()}`);

  const shutdown = async () => {
    await Promise.all([publisher.close(), settler.close(), publishQ.close(), settleQ.close()]);
    health.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
