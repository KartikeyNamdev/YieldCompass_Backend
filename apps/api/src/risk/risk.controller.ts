import { Controller, Get, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { CacheService } from "../infra/cache.service";
import { ProtocolIdPipe } from "../lib/pipes";
import { PoolsRepo } from "../pools/pools.repo";

@Controller("v1/risk")
export class RiskController {
  constructor(private repo: PoolsRepo, private cache: CacheService) {}

  @Get(":protocolId")
  get(@Param("protocolId", new ProtocolIdPipe()) id: string) {
    return this.cache.wrap(`risk:${id}`, 60, async () => {
      const r = await this.repo.getRisk(id);
      if (!r) throw new NotFoundException(`no risk score for ${id}`);
      return { protocol_id: id, score: r.score, breakdown: r.breakdown, sources: r.sources, computed_at: r.computed_at, updated_at: r.computed_at };
    });
  }

  /** Serves the precomputed explanation. The API never calls the model live (CLAUDE.md 7.3). */
  @Post(":protocolId/explain")
  @HttpCode(200)
  explain(@Param("protocolId", new ProtocolIdPipe()) id: string) {
    return this.cache.wrap(`explain:${id}`, 60, async () => {
      const r = await this.repo.getRisk(id);
      if (!r) throw new NotFoundException(`no risk score for ${id}`);
      return {
        protocol_id: id, score: r.score, explanation: r.explanation, served_from: r.explanation_source ?? "stored",
        sources: r.sources, computed_at: r.computed_at, updated_at: r.computed_at,
      };
    });
  }
}
