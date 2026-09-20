import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

export type Db = Pick<Pool, "query">;

export function createPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new Pool({ connectionString: url, max: 10 });
}

/** Run every migrations/*.sql in name order. All migrations are idempotent, so this is safe on every boot. */
export async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)"); // several services may boot at once
    for (const f of files) await client.query(readFileSync(join(dir, f), "utf8"));
    return files;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}
