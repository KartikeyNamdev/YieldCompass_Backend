import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

@SkipThrottle()
@Controller()
export class HealthController {
  @Get(["health", "v1/health"])
  health() {
    return { status: "ok", service: "api", updated_at: new Date().toISOString() };
  }
}
