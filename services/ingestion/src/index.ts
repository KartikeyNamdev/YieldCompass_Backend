import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { resolve } from "path";
import { DEFAULT_JOB_OPTIONS, QUEUES, createPool, env, runMigrations, startHealthServer } from "@yc/shared";
import { AnalyticsClient } from "./analytics";
import { Deps, analyzeDocs, computeApy, ingestPools } from "./jobs";

async function main() {
  const pool = createPool();
  const root = resolve(__dirname, "../../..");
  const files = await runMigrations(pool, process.env.MIGRATIONS_DIR ?? resolve(root, "migrations"));
  console.log(`[ingestion] migrations applied: ${files.join(", ")}`);

  const connection = new IORedis(env("REDIS_URL"), { maxRetriesPerRequest: null });
  const q = {
    ingest: new Queue(QUEUES.ingestPools, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    compute: new Queue(QUEUES.computeApy, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    analyze: new Queue(QUEUES.analyzeDocs, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    publish: new Queue(QUEUES.publishRisk, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
  };

  const deps: Deps = {
    pool,
    analytics: new AnalyticsClient(env("ANALYTICS_URL")),
    seedDir: process.env.SEED_DIR ?? resolve(root, "data/seed"),
    liveConfigPath: process.env.LIVE_PROTOCOLS_PATH ?? resolve(root, "data/live_protocols.json"),
    now: () => new Date(),
    enqueue: {
      computeApy: (n, d, o) => q.compute.add(n, d, o),
      analyzeDocs: (n, d, o) => q.analyze.add(n, d, o),
      publishRisk: (n, d, o) => q.publish.add(n, d, o),
    },
  };

  const log = (name: string) => (job: { id?: string }, err: Error) => console.error(`[ingestion] ${name} ${job?.id} failed: ${err.message}`);
  const workers = [
    new Worker(QUEUES.ingestPools, async () => ingestPools(deps), { connection }),
    new Worker(QUEUES.computeApy, async () => computeApy(deps), { connection }),
    new Worker(QUEUES.analyzeDocs, async () => analyzeDocs(deps), { connection }),
  ];
  workers.forEach((w) => w.on("failed", (job, err) => log(w.name)(job ?? {}, err)));
  workers.forEach((w) => w.on("completed", (job, result) => console.log(`[ingestion] ${w.name} ${job.id} ok`, JSON.stringify(result))));

  // schedules: ingest every 5 minutes, docs daily; both also run once at boot
  await q.ingest.upsertJobScheduler("ingest-every-5m", { every: 5 * 60_000 }, { name: "ingest", data: {} });
  await q.analyze.upsertJobScheduler("analyze-daily", { every: 24 * 3600_000 }, { name: "analyze", data: { reason: "daily" } });
  await q.ingest.add("ingest", { reason: "boot" }, { jobId: `boot-${Date.now()}` });

  startHealthServer("ingestion", Number(process.env.PORT ?? 4001), () => ({ demo_mode: deps.demo ?? process.env.DEMO_MODE !== "false" }));

  const shutdown = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(q).map((x) => x.close()));
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
