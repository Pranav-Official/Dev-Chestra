import { describe, expect, it } from "vitest";
import {
  type ExecutionDetailResponse,
  executionDetailResponseSchema,
  jsonObjectSchema,
  jsonValueSchema,
} from "../src/index.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const RAW = `{"__proto__":{"marker":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"kept":true},"payload":{"items":[1,false,null,{"free":"yes"}],"zero":0}}`;

function rawPayload(): Record<string, unknown> {
  return JSON.parse(RAW) as Record<string, unknown>;
}

function ownData(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null) return undefined;
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

describe("JSON payload schemas", () => {
  it("preserves own prototype-related keys at the root and nested levels", () => {
    for (const schema of [jsonValueSchema, jsonObjectSchema]) {
      const raw = rawPayload();
      const parsed = schema.parse(raw) as Record<string, unknown>;

      expect(parsed).toBe(raw);
      expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
      expect(ownData(parsed, "__proto__")).toEqual({ marker: true });
      expect(Object.hasOwn(parsed, "constructor")).toBe(true);
      expect(Object.hasOwn(parsed, "prototype")).toBe(true);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);

      const payload = parsed.payload as Record<string, unknown>;
      expect(payload).toBe(raw.payload);
      expect(Object.hasOwn(payload, "items")).toBe(true);
      expect(payload.zero).toBe(0);
      expect(payload.items).toEqual([1, false, null, { free: "yes" }]);

      const nested = (payload.items as unknown[])[3] as Record<string, unknown>;
      expect(Object.hasOwn(nested, "free")).toBe(true);
    }

    expect(Object.hasOwn(Object.prototype, "marker")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).marker).toBeUndefined();
  });

  it("preserves primitives, arrays, null-prototype objects and identity", () => {
    const values: unknown[] = [null, false, 0, "", "text", [], [null, false, 0, "x"]];
    for (const value of values) {
      expect(jsonValueSchema.parse(value)).toBe(value);
    }

    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: 1,
      list: [false, null, 0],
    });
    expect(jsonValueSchema.parse(nullProto)).toBe(nullProto);
    expect(jsonObjectSchema.parse(nullProto)).toBe(nullProto);

    const array = [null, false, 0, { nested: true }];
    const object = { array, value: null };
    expect(jsonValueSchema.parse(object)).toBe(object);
    expect(jsonObjectSchema.parse(object)).toBe(object);
  });

  it("requires an object root for jsonObjectSchema", () => {
    for (const value of [[], [1], null, false, 0, "", "text", true]) {
      expect(jsonObjectSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects non-JSON values anywhere in the structure", () => {
    const sparseArray = [1, 2, 3];
    delete sparseArray[1];
    const badValues: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      () => undefined,
      Symbol("x"),
      1n,
      new Date(),
      new Map(),
      new (class {
        value = 1;
      })(),
      { nested: Number.NaN },
      { nested: undefined },
      { nested: () => undefined },
      [Number.NaN],
      [undefined],
      sparseArray,
    ];

    for (const value of badValues) {
      expect(jsonValueSchema.safeParse(value).success).toBe(false);
    }
    for (const value of badValues.filter(
      (candidate) =>
        typeof candidate === "object" && candidate !== null && !Array.isArray(candidate),
    )) {
      expect(jsonObjectSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects cycles without a synchronous stack overflow and accepts shared references", () => {
    const self: Record<string, unknown> = {};
    self.self = self;

    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);

    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first.second = second;

    for (const value of [self, arrayCycle, first]) {
      for (const schema of [jsonValueSchema, jsonObjectSchema]) {
        expect(() => schema.safeParse(value)).not.toThrow();
        expect(schema.safeParse(value).success).toBe(false);
      }
    }

    const shared = { deep: [1, { x: null }] };
    const sharedArray = [1, { ok: true }];
    const dag = { left: shared, right: shared, list: [shared, sharedArray, sharedArray] };
    expect(jsonValueSchema.parse(dag)).toBe(dag);
    expect(jsonObjectSchema.parse(dag)).toBe(dag);
  });

  it("handles deeply nested values without a synchronous RangeError", () => {
    let deep: unknown = { leaf: true };
    for (let index = 0; index < 20_000; index += 1) {
      deep = { next: deep };
    }

    expect(() => jsonValueSchema.safeParse(deep)).not.toThrow();
    expect(jsonValueSchema.safeParse(deep).success).toBe(true);
  });

  it("rejects accessor properties without executing their getters", () => {
    let called = false;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "danger", {
      enumerable: true,
      get() {
        called = true;
        return 1;
      },
    });

    expect(jsonValueSchema.safeParse(value).success).toBe(false);
    expect(called).toBe(false);
  });

  it("preserves output.data through the typed execution detail response", () => {
    const raw = rawPayload();
    const detail = {
      execution: {
        runId: RUN_ID,
        path: "evaluate[3]/try",
        nodeId: "try",
        status: "succeeded",
        attempt: 1,
        generation: 1,
        kind: "agent",
        validationAttempts: 0,
        validationLimit: 3,
        crashAttempts: 0,
        startedAt: 1,
        endedAt: 2,
        cli: "fake",
        sessionId: null,
        sessionCwd: null,
        model: null,
        outputId: null,
        errorCode: null,
        errorMessage: null,
        branch: null,
        lastEventId: 4,
      },
      attempts: [],
      input: null,
      output: {
        id: "output",
        hash: "hash",
        bytes: 10,
        truncated: false,
        data: raw,
        contentType: "json",
      },
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, costSource: "none" },
      process: null,
      workspace: null,
    };

    const parsed: ExecutionDetailResponse = executionDetailResponseSchema.parse(detail);
    expect(parsed.output).not.toBeNull();
    expect(parsed.output?.data).toBe(raw);
    expect(Object.hasOwn(parsed.output?.data as object, "__proto__")).toBe(true);
    expect(ownData(parsed.output?.data, "__proto__")).toEqual({ marker: true });
  });
});
