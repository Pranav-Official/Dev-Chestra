import { describe, expect, it } from "vitest";
import { z } from "../src/zod.js";

describe("CSP-safe zod", () => {
  it("does not compile schemas with eval/new Function", () => {
    const Original = globalThis.Function;
    let called = false;
    globalThis.Function = new Proxy(Original, {
      construct(target, args, newTarget) {
        called = true;
        return Reflect.construct(target, args, newTarget);
      },
    }) as FunctionConstructor;
    try {
      const parsed = z.object({ value: z.string() }).parse({ value: "ok" });
      expect(parsed).toEqual({ value: "ok" });
      expect(called).toBe(false);
    } finally {
      globalThis.Function = Original;
    }
  });
});
