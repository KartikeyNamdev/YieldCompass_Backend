import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { HealthController } from "./health/health.controller";
import { InfraModule } from "./infra/infra.module";
import { PoolsController } from "./pools/pools.controller";
import { PoolsRepo } from "./pools/pools.repo";
import { RiskController } from "./risk/risk.controller";
import { SeriesController } from "./series/series.controller";
import { SeriesRepo } from "./series/series.repo";
import { WalletController } from "./wallet/wallet.controller";

@Module({
  imports: [InfraModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 120) }])],
  controllers: [HealthController, PoolsController, RiskController, SeriesController, WalletController],
  providers: [PoolsRepo, SeriesRepo, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
