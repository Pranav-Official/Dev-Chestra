import { parsePath } from "@devchestra/core";
import { compileExpression } from "./expression.js";
import { analyzeGraph } from "./graph.js";
import { normalizeOutputSchema } from "./output-schema.js";
import {
  type Graph,
  type Issue,
  type JsonSchemaObject,
  LOOP_MAX_ITERATIONS,
  LOOP_MIN_ITERATIONS,
  LOOP_RESERVED_BODY_IDS,
  type ValidationContext,
  type WorkflowNode,
} from "./types.js";
import { validateLoopBodyChildren, validateNodeBase } from "./validate-node.js";
import { isRecord, issue } from "./validate-support.js";

export { loopEnvelopeSchema } from "./loop-envelope.js";

const BODY_SUPPORTED = new Set([
  "start",
  "agent",
  "shell",
  "gate",
  "join",
  "approval",
  "decision",
  "end",
]);

function err(code: string, message: string, pointer: string, nodeId?: string): Issue {
  return issue("error", code, message, pointer, nodeId);
}

function rootsIn(
  roots: readonly string[],
  allowed: Set<string>,
  pointer: string,
  nodeId: string,
  label: string,
  addError: (i: Issue) => void,
): void {
  for (const root of roots) {
    if (!allowed.has(root)) {
      const list = [...allowed].sort().join(", ");
      addError(
        err(
          "E_EXPR_SCOPE",
          `Expression root '${root}' is not in scope. Allowed: ${list || "(none)"}. Expression: ${label}`,
          pointer,
          nodeId,
        ),
      );
    }
  }
}

function checkExpression(
  value: unknown,
  allowed: Set<string>,
  pointer: string,
  nodeId: string,
  label: string,
  addError: (i: Issue) => void,
  opts?: { allowEmpty?: boolean; code?: string },
): void {
  if (typeof value !== "string" || (value.trim() === "" && opts?.allowEmpty !== true)) {
    if (typeof value !== "string" || value.trim() === "") {
      addError(
        err(
          opts?.code ?? "E_LOOP_EXPR",
          `Loop ${label} must be a non-empty string.`,
          pointer,
          nodeId,
        ),
      );
    }
    return;
  }
  const compiled = compileExpression(value);
  if (!compiled.ok) {
    const detail =
      isRecord(compiled.error.details) && typeof compiled.error.details.pointer === "string"
        ? compiled.error.details.pointer
        : "";
    addError(err("E_EXPR", compiled.error.message, `${pointer}${detail}`, nodeId));
    return;
  }
  rootsIn(compiled.value.roots, allowed, pointer, nodeId, `${label}: ${value}`, addError);
}

/** All nodes recursively, including loop bodies (no nesting by validation). */
export function* workflowNodes(graph: Graph): Generator<WorkflowNode> {
  for (const node of graph.nodes) {
    yield node;
    if (node.type === "loop") {
      const body = (node as { body?: Graph }).body;
      if (isRecord(body) && Array.isArray((body as Graph).nodes)) {
        yield* workflowNodes(body as Graph);
      }
    }
  }
}

export function allWorkflowNodes(graph: Graph): WorkflowNode[] {
  return [...workflowNodes(graph)];
}

/**
 * Resolve a run path to its snapshot node. Round/index segments address the
 * loop body: `refine` -> controller, `refine#2/done` -> body child `done`.
 */
export function nodeAtPath(graph: Graph, path: string): WorkflowNode | undefined {
  const parsed = parsePath(path);
  if (!parsed.ok) return undefined;
  const segments = parsed.value;
  if (segments.length === 0) return undefined;
  const first = segments[0];
  if (first === undefined) return undefined;
  const top = graph.nodes.find((node) => node.id === first.node);
  if (top === undefined) return undefined;
  if (segments.length === 1) return top;
  if (top.type !== "loop") return undefined;
  const body = (top as { body?: Graph }).body;
  if (!isRecord(body) || !Array.isArray((body as Graph).nodes)) return undefined;
  if (segments.length !== 2) return undefined;
  const second = segments[1];
  if (second === undefined) return undefined;
  return (body as Graph).nodes.find((node) => node.id === second.node);
}

/**
 * Optional override for body-child validation. The default reuses the shared
 * single-node validator (no duplication, no circular import). Accepts the
 * computed body scope plus loop-level reference roots for R17 join checks.
 */
export type LoopBodyValidator = (
  body: Graph,
  scopeOf: (nodeId: string) => Set<string>,
  base: string,
  loopId: string,
  extraReferenced: Set<string>,
  addError: (item: Issue) => void,
  addWarning: (item: Issue) => void,
) => void;

export interface ValidateLoopOptions {
  pointer?: string;
  parentAllowed?: Iterable<string>;
  fileId?: string;
  projectKind?: ValidationContext["projectKind"];
  validateBody?: LoopBodyValidator;
}

/**
 * Validate a loop node in isolation (raw snapshot friendly). `parentAllowed`
 * defaults to `{ start }`; pass the real parent scope when known. Returns all
 * issues (errors and warnings distinguished by severity). Body children reuse
 * the shared single-node validator via validate-node.ts, so MCP settings,
 * permission/context restrictions, limits, and empty shell commands fail the
 * same inside bodies as at the top level.
 */
export function validateLoopNode(value: unknown, opts: ValidateLoopOptions = {}): Issue[] {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const addError = (i: Issue): void => void errors.push(i);
  const addWarning = (i: Issue): void => void warnings.push(i);
  const pointer = opts.pointer ?? "/graph/nodes/loop";
  const parentAllowed = new Set<string>(opts.parentAllowed ?? ["start"]);
  if (!isRecord(value)) {
    addError(err("E_LOOP_INVALID", "Loop node must be an object.", pointer));
    return [...errors, ...warnings];
  }
  const nodeId = typeof value.id === "string" ? value.id : "loop";
  if (value.type !== "loop") {
    addError(err("E_LOOP_INVALID", "Loop node type must be 'loop'.", `${pointer}/type`, nodeId));
    return [...errors, ...warnings];
  }
  validateNodeBase(value, pointer, addError);
  if (value.mode !== "repeatUntil") {
    addError(err("E_LOOP_MODE", "Loop mode must be 'repeatUntil'.", `${pointer}/mode`, nodeId));
  }
  const max = value.maxIterations;
  if (
    typeof max !== "number" ||
    !Number.isSafeInteger(max) ||
    max < LOOP_MIN_ITERATIONS ||
    max > LOOP_MAX_ITERATIONS
  ) {
    addError(
      err(
        "E_LOOP_MAX_ITERATIONS",
        `Loop maxIterations must be an integer between ${LOOP_MIN_ITERATIONS} and ${LOOP_MAX_ITERATIONS}.`,
        `${pointer}/maxIterations`,
        nodeId,
      ),
    );
  }
  if (value.output === undefined || !isRecord(value.output)) {
    addError(
      err(
        "E_OUTPUT_SCHEMA",
        "Loop output must be a JSON schema object.",
        `${pointer}/output`,
        nodeId,
      ),
    );
  } else {
    const normalized = normalizeOutputSchema(value.output as JsonSchemaObject);
    if (!normalized.ok) {
      const detail =
        isRecord(normalized.error.details) && typeof normalized.error.details.pointer === "string"
          ? normalized.error.details.pointer
          : "";
      addError(
        err("E_OUTPUT_SCHEMA", normalized.error.message, `${pointer}/output${detail}`, nodeId),
      );
    }
  }

  const body = value.body as Graph | undefined;
  let endAncestors = new Set<string>();
  let scopeOf: ((nodeId: string) => Set<string>) | undefined;
  let bodyGraph: Graph | undefined;
  if (!isRecord(body) || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    addError(
      err(
        "E_LOOP_BODY",
        "Loop body must be an object with nodes and edges arrays.",
        `${pointer}/body`,
        nodeId,
      ),
    );
  } else {
    const topology = validateLoopTopology(body, pointer, nodeId, addError);
    if (topology !== undefined) {
      endAncestors = topology.endAncestors;
      scopeOf = topology.scopeOf;
      bodyGraph = body;
    }
  }

  const resultScope = new Set<string>(["start", "loop", ...endAncestors]);
  const untilScope = new Set<string>([...resultScope, "result"]);

  // Loop-level expression roots feed body R17 join reference detection.
  const loopReferenced = new Set<string>();
  const collectRoots = (expr: unknown): void => {
    if (typeof expr !== "string" || expr.trim() === "") return;
    const compiled = compileExpression(expr);
    if (compiled.ok) {
      for (const root of compiled.value.roots) loopReferenced.add(root);
    }
  };

  if (typeof value.result !== "string" || value.result.trim() === "") {
    addError(
      err(
        "E_LOOP_RESULT",
        "Loop result must be a non-empty expression.",
        `${pointer}/result`,
        nodeId,
      ),
    );
  } else {
    checkExpression(value.result, resultScope, `${pointer}/result`, nodeId, "result", addError, {
      code: "E_LOOP_RESULT",
    });
    collectRoots(value.result);
  }
  if (typeof value.until !== "string" || value.until.trim() === "") {
    addError(
      err(
        "E_LOOP_UNTIL",
        "Loop until must be a non-empty boolean expression.",
        `${pointer}/until`,
        nodeId,
      ),
    );
  } else {
    checkExpression(value.until, untilScope, `${pointer}/until`, nodeId, "until", addError, {
      code: "E_LOOP_UNTIL",
    });
    collectRoots(value.until);
  }
  const initial = value.initialState ?? "{}";
  if (value.initialState !== undefined) {
    checkExpression(
      initial,
      parentAllowed,
      `${pointer}/initialState`,
      nodeId,
      "initialState",
      addError,
      {
        code: "E_LOOP_STATE",
      },
    );
  } else if (typeof initial === "string") {
    const compiled = compileExpression(initial);
    if (!compiled.ok) {
      addError(
        err(
          "E_LOOP_STATE",
          "Loop default initialState failed to compile.",
          `${pointer}/initialState`,
          nodeId,
        ),
      );
    }
  }
  const next = value.nextState ?? "loop.state";
  if (value.nextState !== undefined) {
    checkExpression(next, untilScope, `${pointer}/nextState`, nodeId, "nextState", addError, {
      code: "E_LOOP_STATE",
    });
    collectRoots(value.nextState);
  } else {
    collectRoots(next);
  }

  // Ordinary body-child rules via the shared validator (default) or caller override.
  if (bodyGraph !== undefined && scopeOf !== undefined) {
    const validator = opts.validateBody ?? defaultBodyValidator;
    validator(bodyGraph, scopeOf, pointer, nodeId, loopReferenced, addError, addWarning, opts);
  }
  return [...errors, ...warnings];
}

function defaultBodyValidator(
  body: Graph,
  scopeOf: (nodeId: string) => Set<string>,
  base: string,
  _loopId: string,
  extraReferenced: Set<string>,
  addError: (item: Issue) => void,
  addWarning: (item: Issue) => void,
  opts?: ValidateLoopOptions,
): void {
  validateLoopBodyChildren(body, {
    scopeOf,
    base,
    extraReferenced,
    fileId: opts?.fileId ?? "workflow",
    ctx: { ...(opts?.projectKind === undefined ? {} : { projectKind: opts.projectKind }) },
    addError,
    addWarning,
    addDevChestra: (error, p, n) => {
      const detail =
        isRecord(error.details) && typeof error.details.pointer === "string"
          ? error.details.pointer
          : "";
      addError(issue("error", error.code, error.message, `${p}${detail}`, n));
    },
  });
}

function validateLoopTopology(
  body: Graph,
  base: string,
  loopId: string,
  addError: (item: Issue) => void,
): { endAncestors: Set<string>; scopeOf: (nodeId: string) => Set<string> } | undefined {
  const nodes = body.nodes as WorkflowNode[];

  for (const [index, node] of nodes.entries()) {
    const at = `${base}/body/nodes/${index}`;
    const record = node as unknown as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id !== undefined && (LOOP_RESERVED_BODY_IDS as readonly string[]).includes(id)) {
      addError(
        err(
          "E_LOOP_BODY_ID",
          `Body node id '${id}' is reserved for loop scope ('loop', 'result').`,
          `${at}/id`,
          loopId,
        ),
      );
    }
    if (record.type === "loop") {
      addError(
        err(
          "E_LOOP_NESTED",
          "Nested loops are not supported; loop bodies cannot contain loop nodes.",
          `${at}/type`,
          loopId,
        ),
      );
    } else if (typeof record.type === "string" && !BODY_SUPPORTED.has(record.type)) {
      addError(
        err("E_NODE_TYPE", `Unsupported body node type '${record.type}'.`, `${at}/type`, loopId),
      );
    }
  }

  const { analysis, issues } = analyzeGraph(body);
  for (const item of issues) {
    const remapped =
      item.pointer === undefined ? undefined : item.pointer.replace(/^\/graph/, `${base}/body`);
    addError({ ...item, pointer: remapped ?? `${base}/body`, nodeId: item.nodeId ?? loopId });
  }

  const starts = nodes.filter((node) => node.type === "start");
  const ends = nodes.filter((node) => node.type === "end");
  if (ends.length !== 1) {
    addError(
      err(
        "E_LOOP_BODY",
        `Loop body must have exactly one start and one end (found ${starts.length} start, ${ends.length} end).`,
        `${base}/body/nodes`,
        loopId,
      ),
    );
  }
  const endNode = ends[0];
  if (endNode !== undefined && (endNode as { status?: unknown }).status !== "success") {
    const endIndex = nodes.indexOf(endNode);
    addError(
      err(
        "E_LOOP_BODY_END_STATUS",
        "Loop body end status must be 'success'; failure/rejection ends the run, not a round.",
        `${base}/body/nodes/${Math.max(endIndex, 0)}/status`,
        loopId,
      ),
    );
  }
  const startNode = starts[0];
  if (startNode !== undefined) {
    const params = (startNode as { params?: unknown }).params;
    if (!Array.isArray(params) || params.length !== 0) {
      const startIndex = nodes.indexOf(startNode);
      addError(
        err(
          "E_LOOP_BODY_START_PARAMS",
          "Loop body start params must be empty; parent inputs arrive via loop.parent.",
          `${base}/body/nodes/${Math.max(startIndex, 0)}/params`,
          loopId,
        ),
      );
    }
  }

  // Scratch-only workspaces until a cross-round policy lands.
  for (const [index, node] of nodes.entries()) {
    if (node.type !== "agent" && node.type !== "shell") continue;
    const workspace = (node as { workspace?: unknown }).workspace;
    if (workspace === undefined) continue;
    if (!isRecord(workspace) || workspace.mode !== "scratch") {
      addError(
        err(
          "E_LOOP_BODY_WORKSPACE",
          "Loop body children must use scratch workspaces; worktree/project modes are rejected until cross-round policy lands.",
          `${base}/body/nodes/${index}/workspace`,
          loopId,
        ),
      );
    }
  }

  if (endNode === undefined) return undefined;
  const endAncestors = analysis.ancestors(endNode.id);
  const scopeOf = (id: string): Set<string> =>
    new Set<string>(["start", "loop", ...analysis.ancestors(id)]);
  return { endAncestors, scopeOf };
}

export function validateLoopForWorkflow(
  node: WorkflowNode,
  pointer: string,
  parentAllowed: Set<string>,
  addError: (item: Issue) => void,
  addWarning: (item: Issue) => void = () => {},
  validateBody?: LoopBodyValidator,
  ctx?: ValidateLoopOptions,
): void {
  const issues = validateLoopNode(node as unknown, {
    pointer,
    parentAllowed,
    ...(validateBody === undefined ? {} : { validateBody }),
    ...(ctx?.fileId === undefined ? {} : { fileId: ctx.fileId }),
    ...(ctx?.projectKind === undefined ? {} : { projectKind: ctx.projectKind }),
  });
  for (const item of issues) {
    if (item.severity === "error") addError(item);
    else addWarning(item);
  }
}
