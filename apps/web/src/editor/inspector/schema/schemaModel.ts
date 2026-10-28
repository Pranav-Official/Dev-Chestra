import type { JsonSchemaObject } from "@relay/schema";
import { isRecord } from "@relay/core";
import { stableStringify } from "../stableStringify.js";

export type PropertyKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "arrayStrings"
  | "object"
  | "any"
  | "advanced";

export interface SchemaRow {
  uid: string;
  name: string;
  kind: PropertyKind;
  sourceKind: PropertyKind;
  source: unknown;
  complex: boolean;
  required: boolean;
  description: string;
  descriptionDirty: boolean;
  maxItems: number | undefined;
  minItems: number | undefined;
}

export const DEFAULT_MAX_ITEMS = 20;

/** Canonical free-form object output: any JSON keys, no enumeration. */
export const RAW_OBJECT_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: true,
};

/** Legacy strict scaffold offered when a new raw node moves to Structured. */
export function createStructuredScaffold(): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "points"],
    properties: {
      summary: { type: "string", maxLength: 2000 },
      points: {
        type: "array",
        items: { type: "string", maxLength: 500 },
        minItems: 1,
        maxItems: 8,
      },
    },
  };
}

export function isRawRoot(schema: JsonSchemaObject): boolean {
  return (
    Object.keys(schema).length === 2 &&
    schema.type === "object" &&
    schema.additionalProperties === true
  );
}

let rowCounter = 0;
function nextUid(): string {
  rowCounter += 1;
  return `schema-row-${rowCounter}`;
}

export function schemaSignature(schema: JsonSchemaObject): string {
  return stableStringify(schema);
}

function allowedKeys(kind: PropertyKind): Set<string> {
  switch (kind) {
    case "string":
      return new Set([
        "type",
        "description",
        "title",
        "default",
        "enum",
        "const",
        "minLength",
        "maxLength",
        "pattern",
        "format",
      ]);
    case "number":
    case "integer":
      return new Set([
        "type",
        "description",
        "title",
        "default",
        "enum",
        "const",
        "minimum",
        "maximum",
      ]);
    case "boolean":
      return new Set(["type", "description", "title", "default", "enum", "const"]);
    case "arrayStrings":
      return new Set(["type", "description", "title", "default", "items", "minItems", "maxItems"]);
    case "object":
      return new Set(["type", "description", "title", "default", "additionalProperties"]);
    case "any":
      return new Set();
    case "advanced":
      return new Set();
  }
}

function kindOf(source: Record<string, unknown>): PropertyKind {
  if (Object.keys(source).length === 0) return "any";
  const type = source.type;
  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    return type;
  }
  if (type === "object") return "object";
  if (type === "array") {
    const items = source.items;
    if (isRecord(items) && items.type === "string") return "arrayStrings";
  }
  return "advanced";
}

function isComplex(source: unknown, kind: PropertyKind): boolean {
  if (!isRecord(source) || kind === "advanced") return true;
  const allowed = allowedKeys(kind);
  if (Object.keys(source).some((key) => !allowed.has(key))) return true;
  if (kind === "arrayStrings") {
    const items = source.items;
    if (!isRecord(items) || items.type !== "string") return true;
    const itemKeys = allowedKeys("string");
    if (Object.keys(items).some((key) => !itemKeys.has(key))) return true;
  }
  if (kind === "object") {
    if (source.properties !== undefined || source.required !== undefined) return true;
    if (
      source.additionalProperties !== undefined &&
      typeof source.additionalProperties !== "boolean"
    )
      return true;
  }
  return false;
}

function row(name: string, source: unknown, requiredNames: ReadonlySet<string>): SchemaRow {
  const record = isRecord(source) ? source : {};
  const kind = isRecord(source) ? kindOf(record) : "advanced";
  return {
    uid: nextUid(),
    name,
    kind,
    sourceKind: kind,
    source,
    complex: isComplex(source, kind),
    required: requiredNames.has(name),
    description: typeof record.description === "string" ? record.description : "",
    descriptionDirty: false,
    maxItems:
      kind === "arrayStrings" && typeof record.maxItems === "number" ? record.maxItems : undefined,
    minItems:
      kind === "arrayStrings" && typeof record.minItems === "number" ? record.minItems : undefined,
  };
}

export function canUseBasicRoot(schema: JsonSchemaObject): boolean {
  if (schema.type !== "object") return false;
  if (schema.$ref !== undefined || schema.anyOf !== undefined) return false;
  if (schema.properties !== undefined && !isRecord(schema.properties)) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    return false;
  return true;
}

export function readRows(schema: JsonSchemaObject): SchemaRow[] {
  if (!isRecord(schema.properties)) return [];
  const requiredNames = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  return Object.entries(schema.properties).map(([name, source]) =>
    row(name, source, requiredNames),
  );
}

export function createRow(kind: PropertyKind, name: string): SchemaRow {
  const source: Record<string, unknown> =
    kind === "any" ? {} : { type: kind === "arrayStrings" ? "array" : kind };
  if (kind === "arrayStrings") {
    source.items = { type: "string" };
    source.maxItems = DEFAULT_MAX_ITEMS;
  }
  if (kind === "object") source.additionalProperties = true;
  return {
    uid: nextUid(),
    name,
    kind,
    sourceKind: kind,
    source,
    complex: false,
    required: false,
    description: "",
    descriptionDirty: false,
    maxItems: kind === "arrayStrings" ? DEFAULT_MAX_ITEMS : undefined,
    minItems: undefined,
  };
}

export function nextPropertyName(rows: readonly SchemaRow[]): string {
  const used = new Set(rows.map((entry) => entry.name));
  let index = rows.length + 1;
  while (used.has(`field${index}`)) index += 1;
  return `field${index}`;
}

export function rowsProblem(rows: readonly SchemaRow[]): string | null {
  const names = new Set<string>();
  for (const entry of rows) {
    if (entry.name === "") return "Property names must be non-empty.";
    if (names.has(entry.name)) return `Property name '${entry.name}' is duplicated.`;
    names.add(entry.name);
    if (entry.kind !== "arrayStrings") continue;
    const max = entry.maxItems;
    if (max === undefined || !Number.isSafeInteger(max) || max < 0) {
      return `Array property '${entry.name}' needs a maxItems whole number (0 or more).`;
    }
    if (
      entry.minItems !== undefined &&
      (!Number.isSafeInteger(entry.minItems) || entry.minItems < 0)
    ) {
      return `Array property '${entry.name}' needs a minItems whole number (0 or more).`;
    }
    if (entry.minItems !== undefined && entry.minItems > max) {
      return `Array property '${entry.name}' has minItems greater than maxItems.`;
    }
  }
  return null;
}

function applyDescription(next: Record<string, unknown>, entry: SchemaRow): void {
  if (!entry.descriptionDirty) return;
  if (entry.description === "") delete next.description;
  else next.description = entry.description;
}

function applyArrayBounds(next: Record<string, unknown>, entry: SchemaRow): void {
  if (entry.maxItems !== undefined) next.maxItems = entry.maxItems;
  if (entry.minItems === undefined) delete next.minItems;
  else next.minItems = entry.minItems;
}

function buildProperty(entry: SchemaRow): unknown {
  if (entry.kind === "any") return {};
  const source = entry.source;
  if (entry.complex || entry.kind === "advanced" || !isRecord(source)) {
    if (!isRecord(source)) return source;
    const next = { ...source };
    applyDescription(next, entry);
    if (entry.kind === "arrayStrings") applyArrayBounds(next, entry);
    return next;
  }

  if (entry.kind === entry.sourceKind) {
    const next = { ...source };
    applyDescription(next, entry);
    if (entry.kind === "arrayStrings") {
      next.type = "array";
      next.items = isRecord(source.items)
        ? { ...source.items, type: "string" }
        : { type: "string" };
      applyArrayBounds(next, entry);
    } else if (entry.kind === "object") {
      next.type = "object";
      if (next.additionalProperties === undefined) next.additionalProperties = false;
    } else {
      next.type = entry.kind;
    }
    return next;
  }

  const rebuilt: Record<string, unknown> = {};
  if (entry.descriptionDirty) {
    if (entry.description !== "") rebuilt.description = entry.description;
  } else if (typeof source.description === "string") {
    rebuilt.description = source.description;
  }
  if (typeof source.title === "string") rebuilt.title = source.title;
  if (entry.kind === "arrayStrings") {
    rebuilt.type = "array";
    rebuilt.items = { type: "string" };
    rebuilt.maxItems = entry.maxItems ?? DEFAULT_MAX_ITEMS;
    if (entry.minItems !== undefined) rebuilt.minItems = entry.minItems;
  } else if (entry.kind === "object") {
    rebuilt.type = "object";
    rebuilt.additionalProperties = true;
  } else {
    rebuilt.type = entry.kind;
  }
  return rebuilt;
}

export function buildSchema(base: JsonSchemaObject, rows: readonly SchemaRow[]): JsonSchemaObject {
  const originalProperties = isRecord(base.properties) ? base.properties : {};
  const originalNames = new Set(Object.keys(originalProperties));
  const orphanRequired = Array.isArray(base.required)
    ? base.required.filter(
        (name): name is string => typeof name === "string" && !originalNames.has(name),
      )
    : [];
  const required = [
    ...new Set([
      ...rows.filter((entry) => entry.required).map((entry) => entry.name),
      ...orphanRequired,
    ]),
  ].sort();

  const out: JsonSchemaObject = {
    ...base,
    type: "object",
    properties: Object.fromEntries(rows.map((entry) => [entry.name, buildProperty(entry)])),
    additionalProperties: base.additionalProperties === true,
  };
  if (required.length === 0) delete out.required;
  else out.required = required;
  return out;
}

export const PROPERTY_KINDS: readonly { value: PropertyKind; label: string }[] = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Integer" },
  { value: "boolean", label: "Boolean" },
  { value: "arrayStrings", label: "Array of strings" },
  { value: "object", label: "Object" },
  { value: "any", label: "Any (any JSON value)" },
];

export function kindLabel(kind: PropertyKind): string {
  return PROPERTY_KINDS.find((entry) => entry.value === kind)?.label ?? "Advanced";
}
