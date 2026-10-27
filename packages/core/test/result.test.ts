import { describe, expect, it } from "vitest";
import {
  err,
  isErr,
  isOk,
  isRelayError,
  mapResult,
  ok,
  RelayError,
  unwrap,
  unwrapOr,
} from "../src/index.js";

describe("Result and RelayError", () => {
  it("carries ok and error values", () => {
    expect(isOk(ok(3))).toBe(true);
    expect(isErr(ok(3))).toBe(false);
    expect(unwrap(ok("x"))).toBe("x");
    expect(unwrapOr(err("bad"), "fallback")).toBe("fallback");
    expect(mapResult(ok(2), (n) => n * 2)).toEqual(ok(4));
  });

  it("throws the carried error on unwrap", () => {
    const error = new RelayError("E_VALIDATION", "nope");
    expect(() => unwrap(err(error))).toThrow(error);
  });

  it("preserves stable code, details, retryability and cause", () => {
    const cause = new Error("root");
    const error = new RelayError("E_CONFLICT", "stale", {
      details: { version: 2 },
      retryable: true,
      cause,
    });
    expect(isRelayError(error)).toBe(true);
    expect(error.code).toBe("E_CONFLICT");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ version: 2 });
    expect(error.cause).toBe(cause);
    expect(error.toJSON()).toEqual({
      name: "RelayError",
      code: "E_CONFLICT",
      message: "stale",
      details: { version: 2 },
      retryable: true,
    });
  });
});
