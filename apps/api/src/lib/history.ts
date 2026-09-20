import type { HistoryPoint } from "../pools/pools.repo";

export interface ChartPoint extends HistoryPoint {
  /** Rolling ~7d realized APY (decimal fraction). Null when nothing can be computed. */
  realized_apy: number | null;
}

const DAY = 86_400_000;

/** One point per UTC day (the last one), oldest first. */
export function dailyLast(points: HistoryPoint[]): HistoryPoint[] {
  const byDay = new Map<string, HistoryPoint>();
  for (const p of points) byDay.set(p.ts.slice(0, 10), p); // input is time-ordered, so the last write wins
  return [...byDay.values()];
}

/**
 * Realized APY per point: annualised growth of the share rate over the trailing 7 days when available,
 * otherwise the base APY (what the pool paid before bonus tokens).
 */
export function withRealized(points: HistoryPoint[], windowDays = 7): ChartPoint[] {
  return points.map((p, i) => {
    const t = new Date(p.ts).getTime();
    const start = points.slice(0, i).find((q) => new Date(q.ts).getTime() >= t - windowDays * DAY);
    const days = start ? (t - new Date(start.ts).getTime()) / DAY : 0;
    if (start && days >= 0.5 && start.share_rate && p.share_rate) {
      return { ...p, realized_apy: Math.pow(p.share_rate / start.share_rate, 365 / days) - 1 };
    }
    return { ...p, realized_apy: p.apy_base };
  });
}
