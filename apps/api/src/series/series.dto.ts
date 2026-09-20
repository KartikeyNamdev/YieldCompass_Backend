import { Type } from "class-transformer";
import { IsIn, IsInt, IsString, Matches, Max, Min } from "class-validator";

export class QuoteQuery {
  @IsString() @Matches(/^\d{1,18}(\.\d{1,18})?$/, { message: "amount must be a positive decimal number" }) amount: string;
  @IsIn(["senior", "junior"]) tranche: "senior" | "junior";
}

export class SimulateBody {
  @Type(() => Number) @IsInt() @Min(-10_000) @Max(100_000) yieldBps: number;
}
