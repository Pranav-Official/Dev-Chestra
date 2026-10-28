import { describe, expect, it } from "vitest";
import { canonicalJson, DevChestraError, hashJson, sha256Hex } from "../src/index.js";

describe("canonical JSON and hashing", () => {
  it("sorts keys and drops undefined object properties", () => {
    expect(canonicalJson({ b: 1, a: 2, skip: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: [{ b: true, a: null }] })).toBe('{"z":[{"a":null,"b":true}]}');
  });

  it("normalizes negative zero and preserves round-trip number text", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson([0, -0, 1.5])).toBe("[0,0,1.5]");
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(DevChestraError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(DevChestraError);
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(DevChestraError);
    expect(() => canonicalJson(undefined)).toThrow(DevChestraError);
    expect(() => canonicalJson([undefined])).toThrow(DevChestraError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(DevChestraError);
  });

  it("is stable under key reordering", async () => {
    await expect(hashJson({ a: 1, b: [2, 3] })).resolves.toBe(await hashJson({ b: [2, 3], a: 1 }));
  });

  it("matches the known SHA-256 of abc", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(hashJson({ a: 1 })).resolves.toBe(await sha256Hex('{"a":1}'));
  });
});
