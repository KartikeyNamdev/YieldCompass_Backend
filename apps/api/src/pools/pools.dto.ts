import { IsIn, IsOptional } from "class-validator";

export class ListPoolsQuery {
  @IsOptional() @IsIn(["conservative", "balanced", "aggressive"]) profile?: "conservative" | "balanced" | "aggressive";
  @IsOptional() @IsIn(["risk_adjusted", "headline", "realized", "tvl", "risk"]) sort?: "risk_adjusted" | "headline" | "realized" | "tvl" | "risk";
}

export class HistoryQuery {
  @IsOptional() @IsIn(["7d", "30d"]) window?: "7d" | "30d";
}
