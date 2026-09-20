import { BadRequestException, PipeTransform } from "@nestjs/common";

export class ProtocolIdPipe implements PipeTransform<string, string> {
  transform(v: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) throw new BadRequestException("invalid protocol id");
    return v;
  }
}

/** Series ids are u64: digits only, no leading zeros. */
export class SeriesIdPipe implements PipeTransform<string, string> {
  transform(v: string): string {
    if (!/^(0|[1-9]\d{0,19})$/.test(v) || BigInt(v) > (1n << 64n) - 1n) throw new BadRequestException("invalid series id");
    return v;
  }
}
