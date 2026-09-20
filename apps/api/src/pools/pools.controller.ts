import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { CacheService } from "../infra/cache.service";
import { dailyLast, withRealized } from "../lib/history";
import { ProtocolIdPipe } from "../lib/pipes";
import { PROFILES, rankPools } from "../lib/ranking";
import { HistoryQuery, ListPoolsQuery } from "./pools.dto";
import { PoolsRepo } from "./pools.repo";

const POOLS_TTL = 60;

@Controller("v1/pools")
export class PoolsController {
  constructor(private repo: PoolsRepo, private cache: CacheService) {}

  @Get()
  list(@Query() q: ListPoolsQuery) {
    const profile = q.profile ?? "balanced";
    const sort = q.sort ?? "risk_adjusted";
    return this.cache.wrap(`pools:${profile}:${sort}`, POOLS_TTL, async () => {
      const all = await this.repo.listPools();
      const { included, excluded } = rankPools(all, profile, sort);
      const updated = all.map((p) => p.updated_at).sort().at(-1) ?? null;
      return {
        profile,
        profile_rule: PROFILES[profile].description,
        sort,
        data: included.map((p, i) => ({ rank: i + 1, ...p })),
        excluded,
        data_source: all.some((p) => p.data_source === "seed-synthetic") ? "seed-synthetic" : "live",
        updated_at: updated,
      };
    });
  }

  @Get(":id")
  detail(@Param("id", new ProtocolIdPipe()) id: string) {
    return this.cache.wrap(`pool:${id}`, POOLS_TTL, async () => {
      const [pool, risk] = await Promise.all([this.repo.getPool(id), this.repo.getRisk(id)]);
      if (!pool) throw new NotFoundException(`unknown pool ${id}`);
      return {
        ...pool,
        realized: { "7d": pool.realized_apy_7d, "30d": pool.realized_apy_30d, basis: pool.realized_basis },
        risk: risk && {
          score: risk.score,
          breakdown: risk.breakdown,
          explanation: risk.explanation,
          explanation_source: risk.explanation_source,
          sources: risk.sources,
          computed_at: risk.computed_at,
        },
      };
    });
  }

  @Get(":id/history")
  history(@Param("id", new ProtocolIdPipe()) id: string, @Query() q: HistoryQuery) {
    const window = q.window ?? "30d";
    return this.cache.wrap(`history:${id}:${window}`, POOLS_TTL, async () => {
      const days = window === "7d" ? 7 : 30;
      // fetch a week of lead-in so the rolling 7d realized APY exists for the first charted day
      const raw = await this.repo.history(id, days + 7);
      if (raw.length === 0) throw new NotFoundException(`no history for ${id}`);
      const daily = withRealized(dailyLast(raw));
      const end = new Date(daily[daily.length - 1].ts).getTime();
      const points = daily.filter((p) => new Date(p.ts).getTime() >= end - days * 86_400_000);
      return { protocol_id: id, window, points, updated_at: points[points.length - 1].ts };
    });
  }
}
