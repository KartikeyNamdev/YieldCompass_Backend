import { describe, expect, it } from "vitest";
import { fractionToBps, protocolIdFromBytes, protocolIdToBytes } from "./risk";

describe("protocol id bytes", () => {
  it("round trips and pads to 32 bytes", () => {
    const b = protocolIdToBytes("aurora-lend");
    expect(b.length).toBe(32);
    expect(protocolIdFromBytes(b)).toBe("aurora-lend");
  });
  it("rejects empty and oversized ids", () => {
    expect(() => protocolIdToBytes("")).toThrow();
    expect(() => protocolIdToBytes("x".repeat(33))).toThrow();
  });
  it("matches the padding used by the on-chain tests", () => {
    const expected = Buffer.alloc(32);
    expected.write("proto-1");
    expect(Buffer.from(protocolIdToBytes("proto-1")).equals(expected)).toBe(true);
  });
});

describe("fractionToBps", () => {
  it("converts and clamps", () => {
    expect(fractionToBps(0.0523)).toBe(523);
    expect(fractionToBps(-1)).toBe(0);
    expect(fractionToBps(NaN)).toBe(0);
    expect(fractionToBps(2, 10_000)).toBe(10_000);
  });
});
