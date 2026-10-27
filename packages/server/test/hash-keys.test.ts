import { describe, expect, it } from "vitest";
import { hashJson, OutputValidator, stableStringify } from "../src/index.js";

type Schema = Record<string, unknown> & {
  properties: { value: { const: Record<string, unknown> } };
};

const schemaWithProtoConst = (): Schema =>
  JSON.parse(
    '{"type":"object","properties":{"value":{"const":{"__proto__":{"marker":1}}}},"additionalProperties":false}',
  ) as Schema;

const schemaWithEmptyConst = (): Schema =>
  JSON.parse(
    '{"type":"object","properties":{"value":{"const":{}}},"additionalProperties":false}',
  ) as Schema;

describe("hashJson own keys", () => {
  it("distinguishes schemas whose const value has an own __proto__ key", () => {
    const withProto = schemaWithProtoConst();
    const empty = schemaWithEmptyConst();

    expect(Object.hasOwn(withProto.properties.value.const, "__proto__")).toBe(true);
    expect(stableStringify(withProto)).toContain('"__proto__":{"marker":1}');
    expect(hashJson(withProto)).not.toBe(hashJson(empty));
  });

  it("keeps ordinary canonical hashes unchanged", () => {
    const value = { b: 2, a: 1, nested: { z: true, a: [1, 2] } };

    expect(stableStringify(value)).toBe('{"a":1,"b":2,"nested":{"a":[1,2],"z":true}}');
    expect(hashJson(value)).toBe(
      "b466e0ed499a76bc02435e105b09c3dd52148c274559f82aa254fcc718e24d9b",
    );
  });

  it("does not collide in the output validator schema cache", () => {
    const withProto = schemaWithProtoConst();
    const empty = schemaWithEmptyConst();
    const validator = new OutputValidator();

    const protoCompiled = validator.compile(withProto);
    const emptyCompiled = validator.compile(empty);

    expect(protoCompiled.hash).not.toBe(emptyCompiled.hash);
    expect(protoCompiled.validate({ value: {} }).ok).toBe(false);
    expect(emptyCompiled.validate({ value: {} }).ok).toBe(true);

    const protoAgain = validator.compile(withProto);
    expect(protoAgain.hash).toBe(protoCompiled.hash);
    expect(protoAgain.validate({ value: {} }).ok).toBe(false);
    expect(emptyCompiled.validate({ value: {} }).ok).toBe(true);
  });

  it("does not pollute Object.prototype", () => {
    hashJson(schemaWithProtoConst());
    new OutputValidator().compile(schemaWithProtoConst());

    expect(Object.hasOwn(Object.prototype, "marker")).toBe(false);
    expect(({} as Record<string, unknown>).marker).toBeUndefined();
  });
});
