import { Global, Module } from "@nestjs/common";
import { createPool } from "@yc/shared/dist/db";
import Redis from "ioredis";
import { CacheService } from "./cache.service";
import { PG, REDIS } from "./tokens";

@Global()
@Module({
  providers: [
    { provide: PG, useFactory: () => createPool() },
    {
      provide: REDIS,
      useFactory: () => {
        if (!process.env.REDIS_URL) return null;
        const r = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
        r.on("error", () => undefined); // handled per call in CacheService
        r.connect().catch(() => undefined);
        return r;
      },
    },
    CacheService,
  ],
  exports: [PG, REDIS, CacheService],
})
export class InfraModule {}
