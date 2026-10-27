import { canonicalJson, type RelayError, type Result } from "@relay/core";
import { analyzeGraph } from "./graph.js";
import { normalizeOutputSchema } from "./output-schema.js";
import type { Graph, Issue, JoinNode, JsonSchemaObject, WorkflowNode } from "./types.js";

export type SchemaAssignability = "yes" | "no" | "unknown";

export interface JoinSource {
  readonly input: string;
  readonly nodeId: string | null;
  readonly branchId?: string;
  readonly schema: JsonSchemaObject | null;
  readonly known: boolean;
}

export const GATE_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: { branch: { type: "string" } },
  required: ["branch"],
  additionalProperties: false,
};

export const SHELL_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    exitCode: { type: "integer" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    durationMs: { type: "number" },
  },
  required: ["exitCode", "stdout", "stderr", "durationMs"],
  additionalProperties: false,
};

const OPAQUE_OBJECT: JsonSchemaObject = { type: "object", additionalProperties: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalize(schema: JsonSchemaObject): JsonSchemaObject | null {
  const result = normalizeOutputSchema(schema);
  return result.ok ? result.value : null;
}

function outputSchema(node: WorkflowNode | undefined): JsonSchemaObject | null {
  if (node === undefined) return null;
  switch (node.type) {
    case "agent":
      return normalize(node.output);
    case "shell":
      return SHELL_OUTPUT_SCHEMA;
    case "gate":
      return GATE_OUTPUT_SCHEMA;
    case "join":
      return node.output === undefined ? null : normalize(node.output);
    case "approval":
      return null;
    case "start":
      return OPAQUE_OBJECT;
    case "end":
      return null;
  }
}

/** Source schemas for a join's declared inputs, in sorted input order. */
export function analyzeJoinSources(graph: Graph, join: JoinNode): JoinSource[] {
  const { analysis } = analyzeGraph(graph);
  return [...join.inputs].sort().map((input) => {
    const edges = (analysis.incoming.get(join.id) ?? []).filter(
      (edge) => analysis.targetHandle(edge) === input,
    );
    const edge = edges.length === 1 ? edges[0] : undefined;
    if (edge === undefined) return { input, nodeId: null, schema: null, known: false };
    const resolved = analysis.resolvedByEdgeId.get(edge.id);
    if (resolved === undefined) return { input, nodeId: null, schema: null, known: false };
    const schema = outputSchema(analysis.nodesById.get(resolved.fromNode));
    return {
      input,
      nodeId: resolved.fromNode,
      ...(resolved.fromHandle === null ? {} : { branchId: resolved.fromHandle }),
      schema,
      known: schema !== null,
    };
  });
}

export interface JoinOutputCheck {
  /** True when mode is 'first' and sources have more than one distinct known shape. */
  readonly requiresOutput: boolean;
  /** Distinct known schemas, plus one for any unknown source shape. */
  readonly distinctSchemas: number;
  readonly hasUnknownSource: boolean;
  readonly incompatible: string[];
  readonly undecidable: string[];
}

export function checkJoinOutput(join: JoinNode, sources: readonly JoinSource[]): JoinOutputCheck {
  const shapes = new Set<string>();
  let unknownSources = 0;
  for (const source of sources) {
    if (source.schema === null) {
      unknownSources += 1;
      continue;
    }
    shapes.add(canonicalJson(source.schema));
  }
  const hasUnknownSource = unknownSources > 0;
  const distinctSchemas = shapes.size + unknownSources;
  const target = join.output === undefined ? null : normalize(join.output);
  const incompatible: string[] = [];
  const undecidable: string[] = [];
  if (target !== null) {
    for (const source of sources) {
      if (source.schema === null) {
        undecidable.push(source.input);
        continue;
      }
      const verdict = assignableOutputSchemas(source.schema, target);
      if (verdict === "no") incompatible.push(source.input);
      if (verdict === "unknown") undecidable.push(source.input);
    }
  }
  return {
    requiresOutput: join.mode === "first" && distinctSchemas > 1,
    distinctSchemas,
    hasUnknownSource,
    incompatible,
    undecidable,
  };
}

function resolveRef(schema: JsonSchemaObject, ref: string): JsonSchemaObject | undefined {
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (match === null) return undefined;
  const name = (match[1] ?? "").replace(/~1/g, "/").replace(/~0/g, "~");
  const defs = schema.$defs;
  if (!isRecord(defs)) return undefined;
  const target = defs[name];
  return isRecord(target) ? target : undefined;
}

function deref(root: JsonSchemaObject, schema: JsonSchemaObject): JsonSchemaObject | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  return resolveRef(root, ref);
}

function types(schema: JsonSchemaObject): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

function sameType(source: string | undefined, target: string | undefined): SchemaAssignability {
  if (source === undefined || target === undefined) return "unknown";
  if (source === target) return "yes";
  if (source === "integer" && target === "number") return "yes";
  return "no";
}

function enumValues(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function compareEnum(source: JsonSchemaObject, target: JsonSchemaObject): SchemaAssignability {
  const sourceValues = enumValues(source.enum);
  const targetValues = enumValues(target.enum);
  const targetConst = target.const;
  if (sourceValues !== undefined && targetValues !== undefined) {
    return sourceValues.every((value) =>
      targetValues.some((candidate) => canonicalJson(candidate) === canonicalJson(value)),
    )
      ? "yes"
      : "no";
  }
  if (sourceValues !== undefined && targetConst !== undefined) {
    return sourceValues.length === 1 &&
      canonicalJson(sourceValues[0]) === canonicalJson(targetConst)
      ? "yes"
      : "no";
  }
  if (source.const !== undefined && targetValues !== undefined) {
    return targetValues.some((value) => canonicalJson(value) === canonicalJson(source.const))
      ? "yes"
      : "no";
  }
  if (source.const !== undefined && targetConst !== undefined) {
    return canonicalJson(source.const) === canonicalJson(targetConst) ? "yes" : "no";
  }
  return "unknown";
}

function merge(current: SchemaAssignability, next: SchemaAssignability): SchemaAssignability {
  if (current === "no" || next === "no") return "no";
  if (current === "unknown" || next === "unknown") return "unknown";
  return "yes";
}

function compareBounds(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  minimumKey: "minimum" | "minItems" | "minLength",
  maximumKey: "maximum" | "maxItems" | "maxLength",
): SchemaAssignability {
  let verdict: SchemaAssignability = "yes";
  const sourceMax = source[maximumKey];
  const targetMax = target[maximumKey];
  if (typeof targetMax === "number") {
    if (typeof sourceMax !== "number") return "unknown";
    if (sourceMax > targetMax) return "no";
  }
  const sourceMin = source[minimumKey];
  const targetMin = target[minimumKey];
  if (typeof targetMin === "number") {
    if (typeof sourceMin !== "number") verdict = merge(verdict, "unknown");
    else if (sourceMin < targetMin) verdict = "no";
  }
  return verdict;
}

/**
 * Conservative structural assignability (spec 5.4.3). Unknown means the editor
 * warns and the runtime validator enforces the join output schema.
 */
export function assignableOutputSchemas(
  sourceRoot: JsonSchemaObject,
  targetRoot: JsonSchemaObject,
): SchemaAssignability {
  const seen = new Set<string>();
  const compare = (
    sourceInput: JsonSchemaObject,
    targetInput: JsonSchemaObject,
    depth: number,
  ): SchemaAssignability => {
    if (depth > 12) return "unknown";
    const source = deref(sourceRoot, sourceInput);
    const target = deref(targetRoot, targetInput);
    if (source === undefined || target === undefined) return "unknown";
    const key = `${canonicalJson(sourceInput)}|${canonicalJson(targetInput)}`;
    if (seen.has(key)) return "unknown";
    seen.add(key);

    const sourceAny = Array.isArray(source.anyOf) ? source.anyOf : undefined;
    if (sourceAny !== undefined) {
      let verdict: SchemaAssignability = "yes";
      for (const branch of sourceAny) {
        if (!isRecord(branch)) return "unknown";
        verdict = merge(verdict, compare(branch, target, depth + 1));
        if (verdict === "no") return "no";
      }
      return verdict;
    }
    const targetAny = Array.isArray(target.anyOf) ? target.anyOf : undefined;
    if (targetAny !== undefined) {
      let verdict: SchemaAssignability = "no";
      for (const branch of targetAny) {
        if (!isRecord(branch)) return "unknown";
        const branchVerdict = compare(source, branch, depth + 1);
        if (branchVerdict === "yes") return "yes";
        if (branchVerdict === "unknown") verdict = "unknown";
      }
      return verdict;
    }

    const enumVerdict = compareEnum(source, target);
    if (enumVerdict !== "unknown") return enumVerdict;

    const typeVerdict = sameType(types(source), types(target));
    if (typeVerdict === "no") return "no";
    let verdict: SchemaAssignability = typeVerdict;

    const targetType = types(target) ?? (target.properties !== undefined ? "object" : undefined);
    const sourceType = types(source) ?? (source.properties !== undefined ? "object" : undefined);

    if (targetType === "object") {
      if (sourceType !== undefined && sourceType !== "object") return "no";
      const targetProperties = isRecord(target.properties) ? target.properties : {};
      const sourceProperties = isRecord(source.properties) ? source.properties : {};
      const required = Array.isArray(target.required) ? target.required : [];
      for (const name of required) {
        if (typeof name !== "string") return "unknown";
        const targetProperty = targetProperties[name];
        if (!isRecord(targetProperty)) return "unknown";
        const sourceProperty = sourceProperties[name];
        if (isRecord(sourceProperty)) {
          verdict = merge(verdict, compare(sourceProperty, targetProperty, depth + 1));
        } else if (source.additionalProperties === true) {
          verdict = merge(verdict, "unknown");
        } else {
          return "no";
        }
        if (verdict === "no") return "no";
      }
      if (target.additionalProperties === false) {
        if (source.additionalProperties === true) verdict = merge(verdict, "unknown");
        else if (source.additionalProperties !== false) verdict = merge(verdict, "unknown");
        else {
          const allowed = new Set(Object.keys(targetProperties));
          for (const name of Object.keys(sourceProperties)) {
            if (!allowed.has(name)) return "no";
          }
        }
      }
    } else if (targetType === "array") {
      if (sourceType !== undefined && sourceType !== "array") return "no";
      verdict = merge(verdict, compareBounds(source, target, "minItems", "maxItems"));
      if (isRecord(target.items)) {
        if (!isRecord(source.items)) return "unknown";
        verdict = merge(verdict, compare(source.items, target.items, depth + 1));
      }
    } else if (targetType === "number" || targetType === "integer") {
      verdict = merge(verdict, compareBounds(source, target, "minimum", "maximum"));
    } else if (targetType === "string") {
      verdict = merge(verdict, compareBounds(source, target, "minLength", "maxLength"));
      if (typeof target.pattern === "string" && typeof source.pattern !== "string") {
        verdict = merge(verdict, "unknown");
      }
    }
    return verdict;
  };
  return compare(sourceRoot, targetRoot, 0);
}

/** Normalize a declared join output; returns null when absent. */
export function normalizeJoinOutput(join: JoinNode): Result<JsonSchemaObject | null, RelayError> {
  if (join.output === undefined) return { ok: true, value: null };
  const result = normalizeOutputSchema(join.output);
  return result.ok ? { ok: true, value: result.value } : result;
}

/** R17 checks for a referenced join. Unreferenced joins need no output schema. */
export function joinOutputIssues(
  file: Graph,
  join: JoinNode,
  index: number,
  referenced: boolean,
): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (join.mode !== "first" || !referenced) return { errors, warnings };
  const sources = analyzeJoinSources(file, join);
  const check = checkJoinOutput(join, sources);
  const pointer = `/graph/nodes/${index}`;
  const make = (severity: "error" | "warning", code: string, message: string): Issue => ({
    severity,
    code,
    message,
    pointer: `${pointer}/output`,
    nodeId: join.id,
  });
  if (check.requiresOutput && join.output === undefined) {
    errors.push(
      make(
        "error",
        "E_JOIN_OUTPUT",
        `Join '${join.id}' is referenced and mode 'first' has ${check.distinctSchemas} distinct source shapes; declare output.`,
      ),
    );
    return { errors, warnings };
  }
  if (join.output === undefined) return { errors, warnings };
  for (const input of check.incompatible) {
    errors.push(
      make(
        "error",
        "E_JOIN_ASSIGNABILITY",
        `Join '${join.id}' input '${input}' cannot be assigned to output; widen the output or align the source schema.`,
      ),
    );
  }
  for (const input of check.undecidable) {
    warnings.push(
      make(
        "warning",
        "W_JOIN_ASSIGNABILITY",
        `Join '${join.id}' input '${input}' cannot be proven assignable to output; validate the joined value at runtime.`,
      ),
    );
  }
  return { errors, warnings };
}
