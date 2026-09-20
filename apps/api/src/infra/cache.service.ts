import { Inject, Injectable, Optional } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "./tokens";

/** Read-through Redis cache. Any Redis failure silently falls back to the source, so the API never depends on it. */
@Injectable()
export class CacheService {
  constructor(@Optional() @Inject(REDIS) private redis: Redis | null) {}

  async wrap<T>(key: string, ttlSecs: number, load: () => Promise<T>): Promise<T> {
    if (this.redis) {
      try {
        const hit = await this.redis.get(`yc:${key}`);
        if (hit) return JSON.parse(hit) as T;
      } catch {
        /* cache miss on error */
      }
    }
    const value = await load(); // errors (404, 400) propagate and are never cached
    if (this.redis) {
      try {
        await this.redis.set(`yc:${key}`, JSON.stringify(value), "EX", ttlSecs);
      } catch {
        /* ignore */
      }
    }
    return value;
  }
}
