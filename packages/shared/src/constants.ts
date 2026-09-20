export const QUEUES = {
  ingestPools: "ingest-pools",
  computeApy: "compute-apy",
  analyzeDocs: "analyze-docs",
  publishRisk: "publish-risk",
  settleSeries: "settle-series",
} as const;

export const DISCLAIMER = "Target rate, not guaranteed. Devnet prototype. Informational only, not financial advice.";

/** Default job options: retries with exponential backoff (CLAUDE.md 7.5). */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const RISK_ENTRY_TTL_SECS = 24 * 3600;

export interface PublishRiskJob {
  protocolId: string;
  score: number;
  computedAt: string;
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var ${name}`);
  return v;
}

export const demoMode = (): boolean => (process.env.DEMO_MODE ?? "true").toLowerCase() !== "false";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
