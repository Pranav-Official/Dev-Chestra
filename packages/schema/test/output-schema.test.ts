import { describe, expect, it } from "vitest";
import { hashOutputSchema, normalizeOutputSchema } from "../src/index.js";

function ok(schema: Record<string, unknown>): Record<string, unknown> {
  const result = normalizeOutputSchema(schema);
  if (!result.ok) throw result.error;
  return result.value;
}

describe("restricted output schema profile", () => {
  it("normalizes objects, arrays, required order and annotations", () => {
    const normalized = ok({
      type: "object",
      description: "dropped annotation",
      additionalProperties: false,
      required: ["b", "a"],
      properties: {
        a: { type: "string", description: "dropped" },
        b: { type: "array", items: { type: "number" }, maxItems: 5 },
      },
    });
    expect(normalized).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
      properties: {
        a: { type: "string" },
        b: { type: "array", items: { type: "number" }, maxItems: 5 },
      },
    });
  });

  it("requires an object top level", () => {
    expect(
      normalizeOutputSchema({ type: "array", items: { type: "string" }, maxItems: 1 }).ok,
    ).toBe(false);
    expect(normalizeOutputSchema({ properties: {} }).ok).toBe(false);
  });

  it("rejects unbounded arrays and non-boolean additional properties", () => {
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
      }).ok,
    ).toBe(false);
    expect(
      normalizeOutputSchema({
        type: "object",
        additionalProperties: true,
        properties: {},
      }).ok,
    ).toBe(true);
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { value: { type: "object", additionalProperties: { type: "string" } } },
      }).ok,
    ).toBe(false);
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { tags: { type: "array", items: [{ type: "string" }], maxItems: 2 } },
      }).ok,
    ).toBe(false);
  });

  it("rejects items on non-arrays and more than 200 properties", () => {
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { value: { type: "string", items: { type: "string" } } },
      }).ok,
    ).toBe(false);
    const properties = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`p${index}`, { type: "string" }]),
    );
    expect(normalizeOutputSchema({ type: "object", properties }).ok).toBe(false);
  });

  it("rejects remote refs, recursion and unsupported keywords", () => {
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: { value: { $ref: "https://example.com/schema.json" } },
      }).ok,
    ).toBe(false);

    const recursive = normalizeOutputSchema({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    });
    expect(recursive.ok).toBe(false);
    if (!recursive.ok) expect(recursive.error.message).toContain("Recursive $ref");

    expect(
      normalizeOutputSchema({
        type: "object",
        properties: {},
        if: { type: "object" },
      }).ok,
    ).toBe(false);
  });

  it("allows a non-recursive local $defs ref and anyOf up to four branches", () => {
    const normalized = ok({
      type: "object",
      properties: {
        tag: { $ref: "#/$defs/Tag" },
        value: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
        },
      },
      $defs: { Tag: { type: "string", maxLength: 32, title: "dropped" } },
    });
    expect(normalized).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        tag: { $ref: "#/$defs/Tag" },
        value: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
        },
      },
      $defs: { Tag: { type: "string", maxLength: 32 } },
    });

    expect(
      normalizeOutputSchema({
        type: "object",
        properties: {
          value: {
            anyOf: [
              { type: "string" },
              { type: "string" },
              { type: "string" },
              { type: "string" },
              { type: "string" },
            ],
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects artifact format in P1 with an unsupported diagnostic", () => {
    const result = normalizeOutputSchema({
      type: "object",
      properties: { report: { type: "string", format: "relay-artifact" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_WORKFLOW_INVALID");
      expect(result.error.message).toContain("Artifact");
    }
  });

  it("keeps own __proto__ property and $defs names as data", async () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    ) as Record<string, unknown>;
    const normalized = ok(schema);
    expect(Object.hasOwn(normalized.properties as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(normalized)).toContain("__proto__");
    await expect(hashOutputSchema(schema)).resolves.toEqual(expect.any(String));

    const defs = JSON.parse(
      '{"type":"object","properties":{"value":{"$ref":"#/$defs/__proto__"}},"$defs":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;
    const normalizedDefs = ok(defs);
    expect(Object.hasOwn(normalizedDefs.$defs as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(normalizedDefs)).toContain("__proto__");
  });

  it("hashes semantically identical schemas identically", async () => {
    const left = await hashOutputSchema({
      type: "object",
      required: ["b", "a"],
      properties: {
        a: { type: "string", description: "x" },
        b: { type: "number" },
      },
    });
    const right = await hashOutputSchema({
      properties: {
        b: { type: "number" },
        a: { type: "string" },
      },
      required: ["a", "b"],
      type: "object",
    });
    expect(left).toBe(right);
  });
});
