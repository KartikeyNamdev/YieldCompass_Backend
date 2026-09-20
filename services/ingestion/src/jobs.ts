import type { Pool } from "pg";
import { demoMode } from "@yc/shared";
import type { AnalyticsClient } from "./analytics";
import { fetchCurrent, fetchHistory, loadLiveProtocols } from "./defillama";
import { loadSeed, loadSeedDocs } from "./seed";
import * as store from "./store";
import type { AnalyzeResponse, Doc, ProtocolRow, SnapshotRow } from "./types";

export interface Enqueue {
  (name: string, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<unknown>;
}

export interface Deps {
  pool: Pool;
  analytics: Pick<AnalyticsClient, "post">;
  seedDir: string;
  liveConfigPath: string;
  now: () => Date;
  enqueue: { computeApy: Enqueue; analyzeDocs: Enqueue; publishRisk: Enqueue };
  demo?: boolean;
  fetchImpl?: typeof fetch;
}

const isDemo = (d: Deps) => d.demo ?? demoMode();

export function toAnalyzeBody(p: ProtocolRow, snaps: SnapshotRow[], extraction?: unknown) {
  return {
    protocol_id: p.id,
    launched: p.launched,
    snapshots: snaps.map((s) => ({ ...s, ts: s.ts.toISOString() })),
    ...(extraction ? { extraction } : {}),
  };
}

// ------------------------------------------------------------------ ingest-pools
export async function ingestPools(d: Deps): Promise<{ protocols: number; snapshots: number }> {
  const now = d.now();
  let protocols: ProtocolRow[];
  let written = 0;
  if (isDemo(d)) {
    const seed = loadSeed(d.seedDir, now);
    protocols = seed.protocols;
    await store.upsertProtocols(d.pool, protocols);
    written = await store.replaceSnapshots(d.pool, protocols.map((p) => p.id), seed.snapshots);
  } else {
    protocols = loadLiveProtocols(d.liveConfigPath);
    await store.upsertProtocols(d.pool, protocols);
    written += await store.insertSnapshots(d.pool, await fetchCurrent(protocols, now, d.fetchImpl));
    for (const p of protocols) {
      if ((await store.countSnapshots(d.pool, p.id)) < 30) {
        written += await store.insertSnapshots(d.pool, await fetchHistory(p, d.fetchImpl));
      }
    }
  }
  // chain the follow-up jobs; job ids make re-delivery idempotent
  const batch = Math.floor(now.getTime() / 60_000);
  await d.enqueue.computeApy("compute", { batch }, { jobId: `compute-${batch}` });
  if ((await store.countRisk(d.pool)) === 0) {
    // one attempt per 5-minute bucket: a permanently failed job must not block later retries
    await d.enqueue.analyzeDocs("analyze", { reason: "first-run" }, { jobId: `analyze-first-${Math.floor(now.getTime() / 300_000)}` });
  }
  return { protocols: protocols.length, snapshots: written };
}

// ------------------------------------------------------------------ compute-apy
export async function computeApy(d: Deps): Promise<{ computed: number; skipped: string[] }> {
  const now = d.now();
  const skipped: string[] = [];
  let computed = 0;
  for (const p of await store.listProtocols(d.pool)) {
    const snaps = await store.getSnapshots(d.pool, p.id);
    if (snaps.length < 2) {
      skipped.push(p.id);
      continue;
    }
    const a = await d.analytics.post<AnalyzeResponse>("/pools/analyze", toAnalyzeBody(p, snaps));
    await store.upsertRealized(d.pool, p.id, 7, a, now);
    await store.upsertRealized(d.pool, p.id, 30, a, now);
    computed++;
  }
  return { computed, skipped };
}

// ------------------------------------------------------------------ analyze-docs
function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchDocs(urls: string[], f: typeof fetch): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const url of urls) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) docs.push({ source: url, text: stripHtml(await res.text()).slice(0, 60_000) });
    } catch {
      /* an unreachable doc simply contributes nothing; the scorer stays conservative */
    }
  }
  return docs;
}

export async function analyzeDocs(d: Deps): Promise<{ analyzed: number; changed: string[] }> {
  const now = d.now();
  const changed: string[] = [];
  let analyzed = 0;
  for (const p of await store.listProtocols(d.pool)) {
    const snaps = await store.getSnapshots(d.pool, p.id);
    if (snaps.length < 2) continue;

    let extraction: unknown;
    const docs = isDemo(d) ? loadSeedDocs(d.seedDir, p.id) : await fetchDocs(p.doc_urls, d.fetchImpl ?? fetch);
    if (isDemo(d) || docs.length > 0) {
      extraction = ((await d.analytics.post<{ extraction: unknown }>("/risk/analyze-docs", { protocol_id: p.id, docs })).extraction);
    }
    const a = await d.analytics.post<AnalyzeResponse>("/pools/analyze", toAnalyzeBody(p, snaps, extraction));
    const ex = await d.analytics.post<{ explanation: string; served_from: string; sources: unknown[] }>("/risk/explain", {
      protocol_id: p.id,
      name: p.name,
      result: a.risk,
    });

    const prev = await store.getRisk(d.pool, p.id);
    await store.upsertRisk(d.pool, p.id, a.risk.score, a.risk.breakdown, ex.explanation, ex.served_from, ex.sources, now);
    analyzed++;
    if (!prev || prev.score !== a.risk.score) {
      changed.push(p.id);
      const computedAt = now.toISOString();
      await d.enqueue.publishRisk("publish", { protocolId: p.id, score: a.risk.score, computedAt }, {
        jobId: `publish-${p.id}-${a.risk.score}-${now.getTime()}`,
      });
    }
  }
  return { analyzed, changed };
}
