import { canonicalJson, DevChestraError, err, ok, type Result } from "@devchestra/core";
import type { JsonSchemaObject } from "./types.js";

const MAX_DEPTH = 8;
const MAX_PROPERTIES = 200;
const MAX_BYTES = 64 * 1024;

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

const ALLOWED = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "description",
  "title",
  "default",
  "$defs",
  "$ref",
  "anyOf",
  "format",
]);

const ANNOTATIONS = new Set(["description", "title", "default"]);

interface NormalizeContext {
  propertyCount: { value: number };
  isRoot: boolean;
}

function invalid(message: string, pointer?: string): DevChestraError {
  return new DevChestraError("E_WORKFLOW_INVALID", message, {
    details: pointer === undefined ? undefined : { pointer },
  });
}

function unsupported(message: string, pointer?: string): DevChestraError {
  return new DevChestraError("E_WORKFLOW_INVALID", message, {
    details: pointer === undefined ? undefined : { pointer },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinPath(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function checkJsonValue(value: unknown, pointer: string): void {
  try {
    canonicalJson(value);
  } catch {
    throw invalid("Value is not representable in JSON", pointer);
  }
}

function integer(value: unknown, name: string, pointer: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw invalid(`${name} must be an integer >= ${min}`, pointer);
  }
  return value;
}

function finite(value: unknown, name: string, pointer: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${name} must be a finite number`, pointer);
  }
  return value;
}

function normalizeSchema(
  raw: unknown,
  depth: number,
  pointer: string,
  ctx: NormalizeContext,
): JsonSchemaObject {
  if (depth > MAX_DEPTH) {
    throw invalid(`Output schema exceeds the maximum depth of ${MAX_DEPTH}`, pointer);
  }
  if (!isRecord(raw)) throw invalid("Schema must be a JSON object", pointer);

  for (const key of Object.keys(raw)) {
    if (!ALLOWED.has(key)) {
      throw invalid(`Unsupported output schema keyword '${key}'`, joinPath(pointer, key));
    }
  }

  const ref = raw.$ref;
  if (ref !== undefined) {
    if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
      throw invalid(
        "Only local $ref values of the form '#/$defs/<name>' are allowed",
        joinPath(pointer, "$ref"),
      );
    }
    for (const key of Object.keys(raw)) {
      if (key !== "$ref" && !ANNOTATIONS.has(key)) {
        throw invalid("$ref cannot be combined with other schema keywords", joinPath(pointer, key));
      }
    }
    return { $ref: ref };
  }

  const anyOf = raw.anyOf;
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || anyOf.length < 1 || anyOf.length > 4) {
      throw invalid("anyOf must contain between 1 and 4 schemas", joinPath(pointer, "anyOf"));
    }
    for (const key of Object.keys(raw)) {
      if (!ANNOTATIONS.has(key) && key !== "anyOf") {
        throw invalid(
          "anyOf cannot be combined with other schema keywords",
          joinPath(pointer, key),
        );
      }
    }
    return {
      anyOf: anyOf.map((branch, index) =>
        normalizeSchema(branch, depth + 1, joinPath(joinPath(pointer, "anyOf"), index), ctx),
      ),
    };
  }

  const out: JsonSchemaObject = {};
  let hasProperties = false;

  if (raw.$defs !== undefined) {
    if (!ctx.isRoot) {
      throw invalid(
        "$defs is only supported at the output schema root",
        joinPath(pointer, "$defs"),
      );
    }
    if (!isRecord(raw.$defs)) {
      throw invalid("$defs must be an object of schemas", joinPath(pointer, "$defs"));
    }
    // Null-prototype builders keep an own "__proto__" key as data instead of
    // invoking Object.prototype's setter (JSON.parse can produce such keys).
    const defs = Object.create(null) as Record<string, JsonSchemaObject>;
    for (const [name, definition] of Object.entries(raw.$defs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw invalid(`Invalid $defs name '${name}'`, joinPath(joinPath(pointer, "$defs"), name));
      }
      defs[name] = normalizeSchema(
        definition,
        depth + 1,
        joinPath(joinPath(pointer, "$defs"), name),
        { ...ctx, isRoot: false },
      );
    }
    out.$defs = defs;
  }

  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !TYPES.has(raw.type)) {
      throw invalid("type must be a single supported JSON Schema type", joinPath(pointer, "type"));
    }
    out.type = raw.type;
  }

  if (raw.properties !== undefined) {
    if (!isRecord(raw.properties)) {
      throw invalid("properties must be an object of schemas", joinPath(pointer, "properties"));
    }
    hasProperties = true;
    const properties = Object.create(null) as Record<string, JsonSchemaObject>;
    for (const [name, property] of Object.entries(raw.properties)) {
      ctx.propertyCount.value += 1;
      if (ctx.propertyCount.value > MAX_PROPERTIES) {
        throw invalid(`Output schema exceeds ${MAX_PROPERTIES} total properties`, pointer);
      }
      properties[name] = normalizeSchema(
        property,
        depth + 1,
        joinPath(joinPath(pointer, "properties"), name),
        { ...ctx, isRoot: false },
      );
    }
    out.properties = properties;
  }

  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.some((name) => typeof name !== "string")) {
      throw invalid("required must be an array of property names", joinPath(pointer, "required"));
    }
    const names = [...new Set(raw.required as string[])].sort();
    const properties = out.properties;
    if (!isRecord(properties)) {
      throw invalid(
        "required needs a properties object on the same schema",
        joinPath(pointer, "required"),
      );
    }
    for (const name of names) {
      if (!Object.hasOwn(properties, name)) {
        throw invalid(
          `required property '${name}' is not declared in properties`,
          joinPath(pointer, "required"),
        );
      }
    }
    out.required = names;
  }

  if (raw.type === "object" || hasProperties) {
    if (out.type === undefined) out.type = "object";
    if (out.type !== "object") {
      throw invalid("properties/required can only be used with type 'object'", pointer);
    }
    const additional = raw.additionalProperties;
    if (additional !== undefined && typeof additional !== "boolean") {
      throw invalid(
        "additionalProperties must be a boolean (true or false); schema-valued values are not supported",
        joinPath(pointer, "additionalProperties"),
      );
    }
    // Omitted keeps the historical closed-object default; explicit false is
    // strict, true permits unknown keys (Raw JSON object).
    out.additionalProperties = additional === true;
  } else if (raw.additionalProperties !== undefined) {
    throw invalid(
      "additionalProperties is only valid on object schemas",
      joinPath(pointer, "additionalProperties"),
    );
  }

  if (raw.items !== undefined) {
    if (raw.type !== "array") {
      throw invalid(
        "items is only valid on array schemas with type 'array'",
        joinPath(pointer, "items"),
      );
    }
    if (Array.isArray(raw.items)) {
      throw invalid("items must be a single schema, not a tuple", joinPath(pointer, "items"));
    }
    out.items = normalizeSchema(raw.items, depth + 1, joinPath(pointer, "items"), {
      ...ctx,
      isRoot: false,
    });
  }

  if (raw.type === "array") {
    if (out.items === undefined) {
      throw invalid(
        "Array schemas must declare a single 'items' schema",
        joinPath(pointer, "items"),
      );
    }
    if (raw.maxItems === undefined) {
      throw invalid("Array schemas must declare maxItems", joinPath(pointer, "maxItems"));
    }
    out.maxItems = integer(raw.maxItems, "maxItems", joinPath(pointer, "maxItems"));
    if (raw.minItems !== undefined) {
      const minItems = integer(raw.minItems, "minItems", joinPath(pointer, "minItems"));
      if (minItems > (out.maxItems as number)) {
        throw invalid("minItems cannot exceed maxItems", joinPath(pointer, "minItems"));
      }
      out.minItems = minItems;
    }
  } else if (raw.maxItems !== undefined || raw.minItems !== undefined) {
    throw invalid("minItems/maxItems are only valid on array schemas", pointer);
  }

  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) {
      throw invalid("enum must be a non-empty array", joinPath(pointer, "enum"));
    }
    for (let i = 0; i < raw.enum.length; i += 1) {
      checkJsonValue(raw.enum[i], joinPath(joinPath(pointer, "enum"), i));
    }
    out.enum = [...raw.enum];
  }

  if (raw.const !== undefined) {
    checkJsonValue(raw.const, joinPath(pointer, "const"));
    out.const = raw.const;
  }

  for (const key of ["minimum", "maximum"] as const) {
    if (raw[key] !== undefined) out[key] = finite(raw[key], key, joinPath(pointer, key));
  }
  if (
    typeof out.minimum === "number" &&
    typeof out.maximum === "number" &&
    out.minimum > out.maximum
  ) {
    throw invalid("minimum cannot exceed maximum", pointer);
  }

  for (const key of ["minLength", "maxLength"] as const) {
    if (raw[key] !== undefined) out[key] = integer(raw[key], key, joinPath(pointer, key));
  }
  if (
    typeof out.minLength === "number" &&
    typeof out.maxLength === "number" &&
    out.minLength > out.maxLength
  ) {
    throw invalid("minLength cannot exceed maxLength", pointer);
  }

  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== "string") {
      throw invalid("pattern must be a string", joinPath(pointer, "pattern"));
    }
    try {
      new RegExp(raw.pattern);
    } catch {
      throw invalid("pattern must be a valid regular expression", joinPath(pointer, "pattern"));
    }
    out.pattern = raw.pattern;
  }

  if (raw.format !== undefined) {
    if (raw.format === "devchestra-artifact") {
      throw unsupported(
        "Artifact outputs (format: 'devchestra-artifact') are not supported; return a path or inline value instead.",
        joinPath(pointer, "format"),
      );
    }
    throw invalid(`Unsupported format '${String(raw.format)}'`, joinPath(pointer, "format"));
  }

  if (!ctx.isRoot && Object.keys(out).length === 0) {
    // A nested/property schema with no constraints (including annotations-only)
    // means Any JSON value: {}, not non-standard {type:"any"}.
    return out;
  }

  if (
    out.type === undefined &&
    out.properties === undefined &&
    out.$defs === undefined &&
    out.enum === undefined &&
    out.const === undefined
  ) {
    throw invalid("Schema must declare a type, properties, enum, const, anyOf or $ref", pointer);
  }

  return out;
}

function resolveRef(root: JsonSchemaObject, ref: string, pointer: string): JsonSchemaObject {
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (match === null) {
    throw invalid(`Unsupported $ref '${ref}'`, pointer);
  }
  const encoded = match[1];
  if (encoded === undefined) throw invalid(`Unsupported $ref '${ref}'`, pointer);
  const name = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
  const defs = root.$defs;
  if (!isRecord(defs)) throw invalid(`$ref '${ref}' has no $defs`, pointer);
  const target = defs[name];
  if (!isRecord(target)) throw invalid(`$ref '${ref}' does not resolve`, pointer);
  return target;
}

function childSchemas(schema: JsonSchemaObject): { schema: JsonSchemaObject; pointer: string }[] {
  const children: { schema: JsonSchemaObject; pointer: string }[] = [];
  if (isRecord(schema.properties)) {
    for (const [name, value] of Object.entries(schema.properties)) {
      if (isRecord(value)) children.push({ schema: value, pointer: `properties/${name}` });
    }
  }
  if (isRecord(schema.items)) children.push({ schema: schema.items, pointer: "items" });
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((value, index) => {
      if (isRecord(value)) children.push({ schema: value, pointer: `anyOf/${index}` });
    });
  }
  if (isRecord(schema.$defs)) {
    for (const [name, value] of Object.entries(schema.$defs)) {
      if (isRecord(value)) children.push({ schema: value, pointer: `$defs/${name}` });
    }
  }
  return children;
}

function assertNoRecursiveRefs(root: JsonSchemaObject): void {
  const checked = new Set<string>();

  function checkRef(ref: string, stack: Set<string>, pointer: string): void {
    if (stack.has(ref)) {
      throw invalid(`Recursive $ref '${ref}' is not allowed`, pointer);
    }
    if (checked.has(ref)) return;
    const target = resolveRef(root, ref, pointer);
    const next = new Set(stack);
    next.add(ref);
    walkRefs(target, next);
    checked.add(ref);
  }

  function walkRefs(schema: JsonSchemaObject, stack: Set<string>): void {
    const ref = schema.$ref;
    if (typeof ref === "string") {
      checkRef(ref, stack, "$ref");
      return;
    }
    for (const child of childSchemas(schema)) walkRefs(child.schema, stack);
  }

  walkRefs(root, new Set());
}

/**
 * Validate and normalize an agent output schema against DevChestra's restricted
 * profile. Annotations are dropped from the normalized/hash form; arrays get a
 * required maxItems; object schemas default to additionalProperties:false
 * unless the author explicitly sets true (Raw JSON object); a nested empty (or
 * annotations-only) schema is Any JSON. Local $defs are allowed but recursion
 * and remote refs are rejected.
 */
export function normalizeOutputSchema(
  schema: JsonSchemaObject,
): Result<JsonSchemaObject, DevChestraError> {
  try {
    if (!isRecord(schema) || schema.type !== "object") {
      throw invalid("Agent output schema must declare type 'object' at the top level", "/type");
    }
    const normalized = normalizeSchema(schema, 0, "", {
      propertyCount: { value: 0 },
      isRoot: true,
    });
    assertNoRecursiveRefs(normalized);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized)).length;
    if (bytes > MAX_BYTES) {
      throw invalid(`Normalized output schema exceeds ${MAX_BYTES} bytes`);
    }
    return ok(normalized);
  } catch (error) {
    if (error instanceof DevChestraError) return err(error);
    return err(
      new DevChestraError("E_INTERNAL", "Could not normalize output schema", { cause: error }),
    );
  }
}
