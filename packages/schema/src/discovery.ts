import { analyzeGraph } from "./graph.js";
import { analyzeJoinSources } from "./join.js";
import { loopEnvelopeSchema } from "./loop-envelope.js";
import { normalizeOutputSchema } from "./output-schema.js";
import type { Graph, JsonSchemaObject, WorkflowNode, WorkflowParam } from "./types.js";

export type Availability =
  | "available"
  | "conditional"
  | "needs-dependency"
  | "unavailable"
  | "loop-scoped";

export interface CatalogProperty {
  /** Property path segments from the node root (empty = whole output). */
  path: string[];
  /** JSON Pointer (RFC 6901) for the property, distinct from expression escaping. */
  jsonPointer: string;
  /** Insertable JSONata expression reference (quoted when needed). */
  expressionRef: string;
  /** Insertable template reference `{{ expr }}` for template fields; raw expr when unsafe. */
  templateRef: string;
  /** True when the template form is unsafe (e.g. key contains }}) — expression may still be fine. */
  templateUnsafe: boolean;
  /** Human type label (string, integer, object, array, union, unknown, ...). */
  typeLabel: string;
  availability: Availability;
  /** Why unavailable/non-insertable (picker shows this as help text). */
  reason?: string;
  /** Bare-ref insertable in this scope. False for e.g. parent nodes in body
   * scope (use loop.parent.*) even though they remain discoverable. */
  insertable: boolean;
  nullable: boolean;
}

export interface NodeCatalog {
  nodeId: string;
  nodeType: WorkflowNode["type"] | "namespace";
  nodeName: string;
  wholeRef: CatalogProperty;
  properties: CatalogProperty[];
}

const MAX_DEPTH = 6;
const MAX_PROPS = 200;
/** Bare JSONata names. Reserved literals must always be quoted (agent.true is invalid). */
const BARE = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED = new Set(["true", "false", "null"]);

function isBare(segment: string): boolean {
  return BARE.test(segment) && !RESERVED.has(segment);
}

function quoteSegment(segment: string): string {
  return `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeSegment(segment: string): string {
  return isBare(segment) ? segment : quoteSegment(segment);
}

/** Serialize one root part (first position): bare or quoted, never raw. */
function serializeRoot(root: string): string {
  return isBare(root) ? root : quoteSegment(root);
}

/**
 * Join pre-split reference parts into a valid JSONata path. Every part is
 * checked for bare-safety (including reserved literals like true/false/null),
 * unusual keys, quotes and escapes. Valid roots (`start`, `loop`, `result`,
 * node ids) are never invented here — callers supply them.
 */
export function toExpressionRefFromParts(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  let out = serializeRoot(parts[0] as string);
  for (const segment of parts.slice(1)) {
    out += `.${escapeSegment(segment)}`;
  }
  return out;
}

/** Serialize a valid JSONata reference without inventing new global roots. */
export function toExpressionRef(root: string, path: readonly string[]): string {
  return toExpressionRefFromParts([root, ...path]);
}

/** Template safety is separate from expression safety (different parser). */
export function isTemplateSafe(expr: string): boolean {
  return !expr.includes("{{") && !expr.includes("}}");
}

export function toTemplateRef(root: string, path: readonly string[]): string | null {
  const expr = toExpressionRef(root, path);
  // Template delimiter handling: keys containing {{ or }} would break {{ }} parsing.
  if (!isTemplateSafe(expr)) return null;
  return `{{ ${expr} }}`;
}

export function toTemplateRefFromParts(parts: readonly string[]): string | null {
  const expr = toExpressionRefFromParts(parts);
  if (!isTemplateSafe(expr)) return null;
  return `{{ ${expr} }}`;
}

/**
 * Mode-aware insertion eligibility. Needs-dependency and unavailable entries
 * stay discoverable but are never insertable (no silent rewiring). Loop-scoped
 * and conditional entries insert only where the target scope actually allows
 * them (the catalogue sets availability from the real scope, not the label).
 * Template mode additionally requires delimiter safety; expression mode does
 * not share that restriction.
 */
export function isInsertableForMode(
  prop: Pick<CatalogProperty, "availability" | "templateUnsafe" | "insertable">,
  mode: "template" | "expression",
): boolean {
  if (!prop.insertable) return false;
  if (prop.availability !== "available" && prop.availability !== "conditional" && prop.availability !== "loop-scoped") {
    return false;
  }
  if (mode === "template" && prop.templateUnsafe) return false;
  return true;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function typeLabelOf(schema: JsonSchemaObject | null): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const record = schema as Record<string, unknown>;
  if (typeof record.$ref === "string") return "ref";
  if (Array.isArray(record.anyOf)) return "union";
  const type = record.type;
  if (type === "array") return "array";
  if (typeof type === "string") return type;
  return "unknown";
}

interface FlattenCtx {
  defs: Record<string, JsonSchemaObject>;
  seenRefs: string[];
  count: { value: number };
}

function resolveLocalRef(ref: string, ctx: FlattenCtx): JsonSchemaObject | null {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) return null;
  const name = ref.slice(prefix.length);
  if (name.length === 0 || ctx.seenRefs.includes(name)) return null;
  const target = ctx.defs[name];
  if (!target || typeof target !== "object") return null;
  ctx.seenRefs.push(name);
  return target;
}

/**
 * Flatten declared schema properties with bounded traversal. Arrays offer the
 * whole array (no invented indices); unions fall back to honestly
 * discoverable object properties only when every branch is an object with
 * properties, else whole-value. Recursive schemas stop at honest whole-value
 * entries via the seen-refs guard.
 */
function flattenSchema(
  schema: JsonSchemaObject | null,
  basePath: string[],
  basePointer: string,
  ctx: FlattenCtx,
  out: Array<{ path: string[]; pointer: string; typeLabel: string; nullable: boolean }>,
): boolean {
  if (ctx.count.value > MAX_PROPS) return false;
  if (basePath.length > MAX_DEPTH) return false;
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const target = resolveLocalRef(record.$ref, ctx);
    if (!target) return false;
    return flattenSchema(target, basePath, basePointer, ctx, out);
  }
  if (Array.isArray(record.anyOf)) {
    if (record.anyOf.length === 0) return false;
    for (const branch of record.anyOf) {
      if (!branch || typeof branch !== "object") return false;
      const brec = branch as Record<string, unknown>;
      if (typeof brec.$ref === "string") {
        const target = resolveLocalRef(brec.$ref, ctx);
        if (!target) return false;
        const before = out.length;
        if (!flattenSchema(target, basePath, basePointer, ctx, out)) {
          out.length = before;
          return false;
        }
        continue;
      }
      if (brec.type !== "object" || typeof brec.properties !== "object" || brec.properties === null) {
        return false;
      }
      const before = out.length;
      const ok = flattenSchema(branch as JsonSchemaObject, basePath, basePointer, ctx, out);
      if (!ok) {
        out.length = before;
        return false;
      }
    }
    return true;
  }
  if (record.type === "array") return false;
  if (record.type !== "object" && record.type !== undefined) return false;
  const props = record.properties;
  if (!props || typeof props !== "object") return false;
  for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
    if (ctx.count.value >= MAX_PROPS) return false;
    if (typeof key !== "string" || key.length === 0) continue;
    const subSchema = sub as JsonSchemaObject;
    const childPath = [...basePath, key];
    const childPointer = `${basePointer}/${escapePointer(key)}`;
    const subRec = (subSchema ?? {}) as Record<string, unknown>;
    const optional = !(Array.isArray(record.required) && (record.required as unknown[]).includes(key));
    if (typeof subRec.$ref === "string") {
      out.push({ path: childPath, pointer: childPointer, typeLabel: "ref", nullable: optional });
      ctx.count.value += 1;
      flattenSchema(subSchema, childPath, childPointer, ctx, out);
    } else if (subRec.type === "object" && typeof subRec.properties === "object" && subRec.properties !== null) {
      out.push({ path: childPath, pointer: childPointer, typeLabel: "object", nullable: optional });
      ctx.count.value += 1;
      flattenSchema(subSchema, childPath, childPointer, ctx, out);
    } else if (subRec.type === "array") {
      out.push({ path: childPath, pointer: childPointer, typeLabel: "array", nullable: optional });
      ctx.count.value += 1;
    } else {
      out.push({ path: childPath, pointer: childPointer, typeLabel: typeLabelOf(subSchema), nullable: optional });
      ctx.count.value += 1;
    }
  }
  return true;
}

function makeProperty(
  rootParts: readonly string[],
  path: string[],
  pointer: string,
  typeLabel: string,
  availability: Availability,
  reason: string | undefined,
  nullable: boolean,
  insertable = true,
): CatalogProperty {
  const expressionRef = toExpressionRefFromParts([...rootParts, ...path]);
  const template = toTemplateRefFromParts([...rootParts, ...path]);
  return {
    path,
    jsonPointer: pointer,
    expressionRef,
    templateRef: template ?? `{{ ${expressionRef} }}`,
    templateUnsafe: template === null,
    typeLabel,
    availability,
    ...(reason === undefined ? {} : { reason }),
    insertable,
    nullable,
  };
}

function catalogForSchema(
  rootParts: readonly string[],
  schema: JsonSchemaObject | null,
  availability: Availability,
  reason: string | undefined,
  opts: { nullableWhole?: boolean; wholeTypeLabel?: string },
): { wholeRef: CatalogProperty; properties: CatalogProperty[] } {
  const wholeRef = makeProperty(
    rootParts,
    [],
    "",
    opts.wholeTypeLabel ?? typeLabelOf(schema),
    availability,
    reason,
    opts.nullableWhole ?? false,
  );
  const properties: CatalogProperty[] = [];
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    const defs = (record.$defs && typeof record.$defs === "object" ? record.$defs : {}) as Record<string, JsonSchemaObject>;
    const flat: Array<{ path: string[]; pointer: string; typeLabel: string; nullable: boolean }> = [];
    const ctx: FlattenCtx = { defs, seenRefs: [], count: { value: 0 } };
    if (flattenSchema(schema, [], "", ctx, flat)) {
      for (const entry of flat) {
        properties.push(
          makeProperty(rootParts, entry.path, entry.pointer, entry.typeLabel, availability, reason, entry.nullable),
        );
      }
    }
  }
  return { wholeRef, properties };
}

function startParamsSchema(params: WorkflowParam[]): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];
  for (const param of params) {
    properties[param.name] = { type: param.type === "enum" ? "string" : param.type } as JsonSchemaObject;
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false } as JsonSchemaObject;
}

const SHELL_SCHEMA: JsonSchemaObject = {
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

const GATE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: { branch: { type: "string" } },
  required: ["branch"],
  additionalProperties: false,
};

const APPROVAL_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    decision: { type: "string" },
    by: { type: "string" },
    note: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};

const DECISION_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    branch: { type: "string" },
    confidence: { type: "number" },
    value: { type: "object", additionalProperties: true },
  },
  required: ["branch"],
  additionalProperties: true,
};

/**
 * Declared output shape per node kind. Raw/unstructured/unknown schemas yield
 * whole-JSON entries only (no invented properties).
 */
export function declaredOutputSchema(node: WorkflowNode): JsonSchemaObject | null {
  switch (node.type) {
    case "start":
      return startParamsSchema((node as { params?: WorkflowParam[] }).params ?? []);
    case "agent": {
      const raw = (node as { output?: JsonSchemaObject }).output ?? null;
      if (!raw) return null;
      const normalized = normalizeOutputSchema(raw);
      return normalized.ok ? normalized.value : null;
    }
    case "shell":
      return SHELL_SCHEMA;
    case "gate":
      return GATE_SCHEMA;
    case "approval":
      return APPROVAL_SCHEMA;
    case "decision":
      return DECISION_SCHEMA;
    case "join":
    case "loop":
    case "end":
      return null;
    default:
      return null;
  }
}

/** Explicit catalogue request: parent graph, local draft, loop identity, field. */
export interface CatalogRequest {
  /** Outer workflow graph (owns the enclosing loop for body fields). */
  parentGraph: Graph;
  /** Local body draft for body fields; the applied graph otherwise. */
  draft?: Graph | undefined;
  /** Enclosing loop id for body fields and controller namespaces. */
  loopId?: string | undefined;
  /** Node owning the edited field (local id inside a draft). */
  nodeId: string;
  /** Field discriminator, e.g. agent.prompt, loop.result, gate.when. */
  field: string;
}

export interface FieldTarget {
  /** Node owning the edited field. */
  nodeId: string;
  /** Field discriminator, e.g. agent.prompt, loop.result, body node id for drafts. */
  field: string;
  /** Inside a loop body draft (local ids + explicit parent context). */
  loopBody?: { loopId: string; localNodeId: string } | undefined;
}

interface ScopeSets {
  /** Bare roots valid in the edited field (node ids plus loop/result). */
  allowed: Set<string>;
  /** Loop namespace is addressable here. */
  loopInScope: boolean;
  /** result namespace is addressable here. */
  resultInScope: boolean;
  /** Parent scope node ids (addressable only via loop.parent in bodies). */
  parentIds: Set<string>;
  /** Body-local ancestor node ids (bare refs) for body fields. */
  bodyIds: Set<string>;
}

type GraphAnalysis = ReturnType<typeof analyzeGraph>["analysis"];

function endAncestorsOf(body: Graph, analysis?: GraphAnalysis): Set<string> {
  const resolved = analysis ?? analyzeGraph(body).analysis;
  const end = body.nodes.find((n) => n.type === "end");
  if (!end) return new Set();
  return new Set(resolved.ancestors(end.id));
}

/**
 * Authoritative field scope. Mirrors the validation rules in validate.ts
 * (top-level `allowed = start + ancestors(node)`) and loop.ts
 * (initialState = parent scope; result = start/loop/end-ancestors;
 * until/nextState = result scope + result; body scopeOf =
 * start/loop/ancestors(local)). One analyzeGraph per graph per call.
 */
function computeScope(req: CatalogRequest, parentAnalysis?: GraphAnalysis, bodyAnalysis?: GraphAnalysis): ScopeSets {
  const parent = parentAnalysis ?? analyzeGraph(req.parentGraph).analysis;
  const loopNode = req.loopId ? req.parentGraph.nodes.find((n) => n.id === req.loopId) : undefined;
  const parentOfLoop = loopNode ? new Set(["start", ...parent.ancestors(loopNode.id)]) : new Set<string>();

  if (req.draft && req.loopId) {
    const body = bodyAnalysis ?? analyzeGraph(req.draft).analysis;
    const localAncestors = new Set(body.ancestors(req.nodeId));
    return {
      allowed: new Set(["start", "loop", ...localAncestors]),
      loopInScope: true,
      resultInScope: false,
      parentIds: parentOfLoop,
      bodyIds: new Set(["start", ...localAncestors]),
    };
  }
  const node = req.parentGraph.nodes.find((n) => n.id === req.nodeId);
  if (node && node.type === "loop" && req.loopId === node.id) {
    const body = node.body;
    const endAncestors = body && Array.isArray((body as Graph).nodes) ? endAncestorsOf(body as Graph, bodyAnalysis) : new Set<string>();
    if (req.field === "initialState") {
      return { allowed: new Set(parentOfLoop), loopInScope: false, resultInScope: false, parentIds: parentOfLoop, bodyIds: new Set() };
    }
    if (req.field === "result") {
      return { allowed: new Set(["start", "loop", ...endAncestors]), loopInScope: true, resultInScope: false, parentIds: parentOfLoop, bodyIds: endAncestors };
    }
    // until / nextState: result scope plus result.
    return { allowed: new Set(["start", "loop", ...endAncestors, "result"]), loopInScope: true, resultInScope: true, parentIds: parentOfLoop, bodyIds: endAncestors };
  }
  return {
    allowed: new Set(["start", ...parent.ancestors(req.nodeId)]),
    loopInScope: false,
    resultInScope: false,
    parentIds: new Set(),
    bodyIds: new Set(),
  };
}

/** A join whose inputs can be dead (downstream of a gate/decision or unconnected). */
function joinCanSkip(graph: Graph, analysis: GraphAnalysis, joinId: string): boolean {
  const inputs = analysis.incoming.get(joinId) ?? [];
  const joinNode = graph.nodes.find((n) => n.id === joinId);
  const declared = joinNode && joinNode.type === "join" ? joinNode.inputs ?? [] : [];
  if (declared.length > inputs.length) return true;
  const ancestors = analysis.ancestors(joinId);
  for (const id of ancestors) {
    const n = analysis.nodesById.get(id);
    if (n && (n.type === "gate" || n.type === "decision")) return true;
  }
  return false;
}

/** True when source is upstream of a skippable join that is upstream of the target scope. */
function isConditionalViaJoin(graph: Graph, analysis: GraphAnalysis, ancestorIds: Set<string>, sourceId: string): boolean {
  for (const id of ancestorIds) {
    const n = graph.nodes.find((m) => m.id === id);
    if (n?.type !== "join") continue;
    if (!joinCanSkip(graph, analysis, id)) continue;
    if (analysis.ancestors(id).has(sourceId)) return true;
  }
  return false;
}

export function availabilityFor(graph: Graph, target: FieldTarget, sourceId: string): { availability: Availability; reason?: string } {
  const req: CatalogRequest = target.loopBody
    ? { parentGraph: graph, draft: undefined, loopId: target.loopBody.loopId, nodeId: target.loopBody.localNodeId, field: target.field }
    : { parentGraph: graph, nodeId: target.nodeId, field: target.field };
  return availabilityForRequest(req, sourceId);
}

export function availabilityForRequest(req: CatalogRequest, sourceId: string): { availability: Availability; reason?: string } {
  const parentAnalysis = analyzeGraph(req.parentGraph).analysis;
  const bodyAnalysis = req.draft ? analyzeGraph(req.draft).analysis : undefined;
  return availabilityWithAnalyses(req, parentAnalysis, bodyAnalysis, sourceId);
}

/** Bulk-path availability sharing one analysis per graph (see catalogForField). */
function availabilityWithAnalyses(
  req: CatalogRequest,
  parentAnalysis: GraphAnalysis,
  bodyAnalysis: GraphAnalysis | undefined,
  sourceId: string,
): { availability: Availability; reason?: string } {
  const scope = computeScope(req, parentAnalysis, bodyAnalysis);
  const ownerId = req.nodeId;

  if (req.draft && req.loopId) {
    if (sourceId === ownerId) {
      return { availability: "unavailable", reason: "A node cannot reference its own output." };
    }
    // The unfinished controller result is never visible inside its own body.
    if (sourceId === req.loopId) {
      return { availability: "unavailable", reason: "The controller envelope is unfinished inside its own body. Use loop.iteration, loop.maxIterations, loop.state or loop.parent instead." };
    }
    const draft = req.draft;
    const localIds = new Set(draft.nodes.map((n) => n.id));
    if (localIds.has(sourceId)) {
      if (sourceId === "start" || scope.bodyIds.has(sourceId)) return { availability: "available" };
      if (bodyAnalysis?.ancestors(sourceId).has(ownerId)) {
        return { availability: "unavailable", reason: "This reference would create a cycle." };
      }
      return { availability: "needs-dependency", reason: "This output is not available here. Connect it as an upstream dependency." };
    }
    if (scope.parentIds.has(sourceId) || req.parentGraph.nodes.some((n) => n.id === sourceId)) {
      return { availability: "loop-scoped", reason: "Parent outputs arrive via loop.parent in the body scope; bare local references are not inserted." };
    }
    if (sourceId === "loop" || sourceId === "result" || sourceId === "loop.parent") {
      if (sourceId === "loop") return { availability: "loop-scoped" };
      return { availability: "unavailable", reason: "This loop namespace is not in scope here." };
    }
    return { availability: "unavailable", reason: "Unknown node." };
  }

  if (sourceId === ownerId) {
    return { availability: "unavailable", reason: "A node cannot reference its own output." };
  }
  if (sourceId === "loop" || sourceId === "result") {
    if (scope.allowed.has(sourceId)) return { availability: "loop-scoped" };
    return { availability: "unavailable", reason: "This loop namespace is not in scope here." };
  }
  if (scope.allowed.has(sourceId)) {
    const node = req.parentGraph.nodes.find((n) => n.id === sourceId);
    if (node?.type === "join") {
      return { availability: "conditional", reason: "Join outputs may be skipped/null depending on the active branch." };
    }
    const ownerAncestors = new Set(parentAnalysis.ancestors(ownerId));
    if (isConditionalViaJoin(req.parentGraph, parentAnalysis, ownerAncestors, sourceId)) {
      return { availability: "conditional", reason: "This ancestor may be skipped when another gate branch wins; expect null." };
    }
    return { availability: "available" };
  }
  if (parentAnalysis.nodesById.has(sourceId)) {
    if (parentAnalysis.ancestors(sourceId).has(ownerId)) {
      return { availability: "unavailable", reason: "This reference would create a cycle." };
    }
    return { availability: "needs-dependency", reason: "This output is not available here. Connect it as an upstream dependency." };
  }
  return { availability: "unavailable", reason: "Unknown node." };
}

function joinCatalog(
  node: Extract<WorkflowNode, { type: "join" }>,
  availability: Availability,
  reason: string | undefined,
  graph: Graph,
): NodeCatalog {
  if (node.mode === "all") {
    const sources = analyzeJoinSources(graph, node);
    const props: CatalogProperty[] = [];
    for (const input of [...node.inputs].sort()) {
      const src = sources.find((s) => s.input === input);
      const schema = (src?.schema ?? null) as JsonSchemaObject | null;
      const avail = availability === "available" ? "conditional" : availability;
      const why = reason ?? "Join inputs may be null when their branch is dead.";
      const whole = makeProperty([node.id], [input], `/${input.replace(/~/g, "~0").replace(/\//g, "~1")}`, schema ? typeLabelOf(schema) : "unknown", avail, why, true);
      props.push(whole);
      if (schema) {
        const { properties } = catalogForSchema([node.id, input], schema, avail, why, {});
        for (const p of properties) {
          props.push({ ...p, path: [input, ...p.path], jsonPointer: `/${escapePointer(input)}${p.jsonPointer}` });
        }
      }
    }
    const wholeExpression = toExpressionRef(node.id, []);
    const wholeTemplate = toTemplateRef(node.id, []);
    return {
      nodeId: node.id,
      nodeType: node.type,
      nodeName: node.name,
      wholeRef: {
        path: [],
        jsonPointer: "",
        expressionRef: wholeExpression,
        templateRef: wholeTemplate ?? `{{ ${wholeExpression} }}`,
        templateUnsafe: wholeTemplate === null,
        insertable: true,
        typeLabel: "object",
        availability: availability === "available" ? "conditional" : availability,
        ...(reason === undefined ? {} : { reason }),
        nullable: true,
      },
      properties: props,
    };
  }
  const declared = node.output ?? null;
  const normalized = declared ? normalizeOutputSchema(declared) : null;
  const schema = normalized?.ok ? normalized.value : null;
  const { wholeRef } = catalogForSchema([node.id], schema, availability === "available" ? "conditional" : availability, reason ?? "First-active join output may be null.", { nullableWhole: true, ...(schema ? {} : { wholeTypeLabel: "unknown" }) });
  return { nodeId: node.id, nodeType: node.type, nodeName: node.name, wholeRef, properties: [] };
}

function loopNamespaceCatalog(req: CatalogRequest, scope: ScopeSets): NodeCatalog[] {
  const out: NodeCatalog[] = [];
  const loopNode = req.parentGraph.nodes.find((n) => n.id === req.loopId);
  if (loopNode?.type !== "loop" || !scope.loopInScope) return out;
  const inBody = req.draft !== undefined;
  const nsProps: CatalogProperty[] = [];
  nsProps.push(makeProperty(["loop"], ["iteration"], "/iteration", "integer", "loop-scoped", undefined, false));
  nsProps.push(makeProperty(["loop"], ["maxIterations"], "/maxIterations", "integer", "loop-scoped", undefined, false));
  const stateWhole = makeProperty(["loop"], ["state"], "/state", "object", "loop-scoped", "Whole loop.state; its structure is caller-defined.", true);
  nsProps.push(stateWhole);
  if (!inBody) {
    const inner = loopNode.output ?? null;
    const normalized = inner ? normalizeOutputSchema(inner) : null;
    const envelope = normalized?.ok ? loopEnvelopeSchema(normalized.value) : null;
    const resultSchema = envelope !== null && typeof envelope === "object"
      ? ((envelope as Record<string, unknown>).properties as Record<string, JsonSchemaObject> | undefined)?.result ?? null
      : null;
    const resWhole = makeProperty(["loop"], ["result"], "/result", resultSchema ? typeLabelOf(resultSchema) : "unknown", "loop-scoped", undefined, true);
    nsProps.push(resWhole);
    if (resultSchema) {
      const { properties: resProps } = catalogForSchema(["loop", "result"], resultSchema, "loop-scoped", undefined, {});
      nsProps.push(...resProps);
    }
  }
  const loopExpr = toExpressionRef("loop", []);
  const loopTpl = toTemplateRef("loop", []);
  out.push({
    nodeId: "loop",
    nodeType: "namespace",
    nodeName: inBody ? "Loop (current round)" : "Loop controller",
    wholeRef: {
      path: [], jsonPointer: "", expressionRef: loopExpr,
      templateRef: loopTpl ?? `{{ ${loopExpr} }}`,
      templateUnsafe: loopTpl === null,
      insertable: true,
      typeLabel: "object", availability: "loop-scoped", nullable: false,
    },
    properties: nsProps,
  });
  // Parent inputs/outputs through loop.parent (never bare locals in bodies).
  const parentEntries: CatalogProperty[] = [];
  for (const pid of [...scope.parentIds].sort()) {
    if (pid === "start") {
      const pnode = req.parentGraph.nodes.find((n) => n.id === "start" || n.type === "start");
      const schema = pnode ? declaredOutputSchema(pnode) : null;
      parentEntries.push(makeProperty(["loop", "parent"], ["start"], "/start", "object", "loop-scoped", undefined, false));
      if (schema) {
        const { properties } = catalogForSchema(["loop", "parent", "start"], schema, "loop-scoped", undefined, {});
        parentEntries.push(...properties.map((p) => ({ ...p, path: ["start", ...p.path], jsonPointer: `/start${p.jsonPointer}` })));
      }
      continue;
    }
    const pnode = req.parentGraph.nodes.find((n) => n.id === pid);
    if (!pnode) continue;
    const schema = declaredOutputSchema(pnode);
    parentEntries.push(makeProperty(["loop", "parent"], [pid], `/${escapePointer(pid)}`, schema ? "object" : "unknown", "loop-scoped", undefined, true));
    if (schema) {
      const { properties } = catalogForSchema(["loop", "parent", pid], schema, "loop-scoped", undefined, {});
      parentEntries.push(...properties.map((p) => ({ ...p, path: [pid, ...p.path], jsonPointer: `/${escapePointer(pid)}${p.jsonPointer}` })));
    }
  }
  const lpExpr = toExpressionRefFromParts(["loop", "parent"]);
  const lpTpl = toTemplateRefFromParts(["loop", "parent"]);
  out.push({
    nodeId: "loop.parent",
    nodeType: "namespace",
    nodeName: "Loop parent",
    wholeRef: {
      path: [], jsonPointer: "", expressionRef: lpExpr,
      templateRef: lpTpl ?? `{{ ${lpExpr} }}`,
      templateUnsafe: lpTpl === null,
      insertable: true,
      typeLabel: "object", availability: "loop-scoped", nullable: false,
    },
    properties: parentEntries,
  });
  return out;
}

function resultNamespaceCatalog(req: CatalogRequest, scope: ScopeSets): NodeCatalog[] {
  if (!scope.resultInScope || !req.loopId) return [];
  const loopNode = req.parentGraph.nodes.find((n) => n.id === req.loopId);
  const inner = loopNode?.type === "loop" ? loopNode.output : null;
  const normalized = inner ? normalizeOutputSchema(inner) : null;
  const schema = normalized?.ok ? normalized.value : null;
  const expr = toExpressionRef("result", []);
  const tpl = toTemplateRef("result", []);
  const { properties } = catalogForSchema(["result"], schema, "loop-scoped", undefined, { nullableWhole: true });
  return [{
    nodeId: "result",
    nodeType: "namespace",
    nodeName: "Round result",
    wholeRef: {
      path: [], jsonPointer: "", expressionRef: expr,
      templateRef: tpl ?? `{{ ${expr} }}`,
      templateUnsafe: tpl === null,
      insertable: true,
      typeLabel: schema ? typeLabelOf(schema) : "unknown",
      availability: "loop-scoped", nullable: true,
    },
    properties,
  }];
}

/** Catalogue for an explicit field request. Each graph is analyzed once here. */
export function catalogForField(req: CatalogRequest): NodeCatalog[] {
  const parentAnalysis = analyzeGraph(req.parentGraph).analysis;
  const bodyAnalysis = req.draft ? analyzeGraph(req.draft).analysis : undefined;
  const scope = computeScope(req, parentAnalysis, bodyAnalysis);
  const out: NodeCatalog[] = [];
  const sourceGraph = req.draft ?? req.parentGraph;
  const bodyMode = req.draft !== undefined && req.loopId !== undefined;

  const draftIds = bodyMode ? new Set(sourceGraph.nodes.map((n) => n.id)) : null;
  for (const node of sourceGraph.nodes) {
    if (node.type === "end") continue;
    if (bodyMode && node.id === req.loopId) continue;
    const r = availabilityWithAnalyses(req, parentAnalysis, bodyAnalysis, node.id);
    if (node.type === "join") {
      out.push(joinCatalog(node, r.availability, r.reason, sourceGraph));
      continue;
    }
    if (node.type === "loop" && !bodyMode) {
      const inner = node.output ?? null;
      const normalized = inner ? normalizeOutputSchema(inner) : null;
      const envelope = normalized?.ok ? loopEnvelopeSchema(normalized.value) : null;
      const { wholeRef, properties } = catalogForSchema([node.id], envelope, r.availability, r.reason, { wholeTypeLabel: "object" });
      out.push({ nodeId: node.id, nodeType: node.type, nodeName: node.name, wholeRef, properties });
      continue;
    }
    if (bodyMode && scope.parentIds.has(node.id)) {
      // Parent-scope nodes stay discoverable in bodies but never as bare locals.
      const schema = declaredOutputSchema(node);
      const { wholeRef } = catalogForSchema([node.id], schema, "loop-scoped", "Parent outputs arrive via loop.parent in the body scope; bare local references are not inserted.", { ...(node.type === "start" ? { wholeTypeLabel: "object" } : {}) });
      out.push({ nodeId: node.id, nodeType: node.type, nodeName: node.name, wholeRef, properties: [] });
      continue;
    }
    const schema = declaredOutputSchema(node);
    const { wholeRef, properties } = catalogForSchema([node.id], schema, r.availability, r.reason, {
      nullableWhole: r.availability === "conditional",
      ...(node.type === "start" ? { wholeTypeLabel: "object" } : {}),
    });
    out.push({ nodeId: node.id, nodeType: node.type, nodeName: node.name, wholeRef, properties });
  }
  if (bodyMode && draftIds) {
    // Parent-scope nodes stay discoverable in bodies but never as bare locals.
    for (const node of req.parentGraph.nodes) {
      if (node.type === "end" || node.type === "loop") continue;
      if (draftIds.has(node.id)) continue;
      const schema = declaredOutputSchema(node);
      const { wholeRef } = catalogForSchema([node.id], schema, "loop-scoped", "Parent outputs arrive via loop.parent in the body scope; bare local references are not inserted.", { ...(node.type === "start" ? { wholeTypeLabel: "object" } : {}) });
      out.push({ nodeId: node.id, nodeType: node.type, nodeName: node.name, wholeRef: { ...wholeRef, insertable: false }, properties: [] });
    }
  }
  out.push(...loopNamespaceCatalog(req, scope));
  out.push(...resultNamespaceCatalog(req, scope));
  return out;
}

/** Back-compat wrapper for top-level fields (no body draft). */
export function catalogWorkflow(graph: Graph, target: FieldTarget): NodeCatalog[] {
  if (target.loopBody) {
    // Legacy single-graph body call: treat the graph as the draft. Parent
    // outputs resolve through loop.parent without bare-local insertion.
    const draft = graph;
    return catalogForField({ parentGraph: graph, draft, loopId: target.loopBody.loopId, nodeId: target.loopBody.localNodeId, field: target.field });
  }
  return catalogForField({ parentGraph: graph, nodeId: target.nodeId, field: target.field, ...(target.nodeId && graph.nodes.some((n) => n.id === target.nodeId && n.type === "loop") ? { loopId: target.nodeId } : {}) });
}
