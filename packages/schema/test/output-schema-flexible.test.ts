import { describe, expect, it } from "vitest";
import { hashOutputSchema, normalizeOutputSchema } from "../src/index.js";

function ok(schema: Record<string, unknown>): Record<string, unknown> {
  const result = normalizeOutputSchema(schema);
  if (!result.ok) throw result.error;
  return result.value;
}

const STRICT = {
  type: "object",
  additionalProperties: false,
  required: ["tags", "title"],
  properties: {
    title: { type: "string", maxLength: 120 },
    tags: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
};

const STRICT_HASH = "d6b843a5ca65edc2b1f67b08a178e6e3b756c6116b34fddcae642b3642098da3";

describe("flexible output schemas", () => {
  it("normalizes a raw root object exactly and hashes deterministically", async () => {
    const raw = { type: "object", additionalProperties: true };
    expect(ok(raw)).toEqual(raw);
    expect(ok({ additionalProperties: true, type: "object" })).toEqual(raw);
    const first = await hashOutputSchema(raw);
    const second = await hashOutputSchema({ additionalProperties: true, type: "object" });
    expect(first).toBe(second);
  });

  it("preserves Any {} in every non-root position", () => {
    const normalized = ok({
      type: "object",
      additionalProperties: true,
      properties: {
        anything: {},
        object: { type: "object", additionalProperties: true },
        list: { type: "array", items: {}, maxItems: 4 },
      },
      $defs: { payload: {} },
    });
    const properties = normalized.properties as Record<string, unknown>;
    expect(properties.anything).toEqual({});
    expect(properties.object).toEqual({ type: "object", additionalProperties: true });
    expect(properties.list).toEqual({ type: "array", items: {}, maxItems: 4 });
    expect((normalized.$defs as Record<string, unknown>).payload).toEqual({});

    const branches = ok({
      type: "object",
      properties: {
        value: { anyOf: [{}, { type: "string" }] },
      },
    });
    const value = (branches.properties as Record<string, unknown>).value as Record<string, unknown>;
    expect(value.anyOf).toEqual([{}, { type: "string" }]);
  });

  it("normalizes annotations-only nested schemas to Any", () => {
    expect(
      ok({
        type: "object",
        properties: {
          value: { description: "free-form", title: "Value", default: { a: 1 } },
        },
      }),
    ).toEqual({ type: "object", properties: { value: {} }, additionalProperties: false });
  });

  it("keeps strict omitted/false additionalProperties and the historical hash", async () => {
    const normalized = ok(STRICT);
    expect(normalized.additionalProperties).toBe(false);
    expect(ok({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const omitted = ok({ type: "object", properties: {} });
    const explicitFalse = ok({ type: "object", properties: {}, additionalProperties: false });
    expect(explicitFalse).toEqual(omitted);
    expect(await hashOutputSchema(STRICT)).toBe(STRICT_HASH);
  });

  it("keeps explicit typed array bounds and rejects unbounded arrays", () => {
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { values: { type: "array", items: {} } },
      }).ok,
    ).toBe(false);
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { values: { type: "array", items: { type: "string" } } },
      }).ok,
    ).toBe(false);
  });

  it("allows true/false additionalProperties only, at root and nested", () => {
    expect(
      ok({
        type: "object",
        additionalProperties: true,
        properties: { nested: { type: "object", additionalProperties: true } },
      }),
    ).toMatchObject({
      additionalProperties: true,
      properties: { nested: { type: "object", additionalProperties: true } },
    });
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: {
          value: { type: "object", additionalProperties: { type: "string" } },
        },
      }).ok,
    ).toBe(false);
  });

  it("keeps root object, remote/recursive ref and unsupported-keyword guards", () => {
    expect(normalizeOutputSchema({}).ok).toBe(false);
    expect(normalizeOutputSchema({ type: "string" }).ok).toBe(false);
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { value: { $ref: "https://example.test/schema.json" } },
      }).ok,
    ).toBe(false);
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { value: { $ref: "#/$defs/loop" } },
        $defs: { loop: { $ref: "#/$defs/loop" } },
      }).ok,
    ).toBe(false);
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { value: { type: "object", patternProperties: {} } },
      }).ok,
    ).toBe(false);
  });

  it("preserves own __proto__ Any properties as data", async () => {
    const schema = JSON.parse(
      '{"type":"object","additionalProperties":true,"properties":{"__proto__":{}}}',
    ) as Record<string, unknown>;
    const normalized = ok(schema);
    expect(Object.hasOwn(normalized.properties as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expect(hashOutputSchema(schema)).resolves.toEqual(expect.any(String));
  });
});
