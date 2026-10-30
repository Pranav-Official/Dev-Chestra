import { defaultControllerBodyValidator, validateControllerTopology } from "./controller-body.js";
import { compileExpression } from "./expression.js";
import type { LoopBodyValidator } from "./loop.js";
import { normalizeOutputSchema } from "./output-schema.js";
import { compileTemplate } from "./template.js";
import {
  FOREACH_DEFAULT_MAX_ITEMS,
  FOREACH_MAX_ITEMS,
  FOREACH_MIN_ITEMS,
  FOREACH_RESERVED_BODY_IDS,
  type ForEachNode,
  type Graph,
  type Issue,
  type ValidationContext,
} from "./types.js";
import { validateNodeBase } from "./validate-node.js";
import { isRecord, issue } from "./validate-support.js";

export { foreachEnvelopeSchema } from "./foreach-envelope.js";

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
  code: string,
): void {
  if (typeof value !== "string" || value.trim() === "") {
    addError(err(code, `ForEach ${label} must be a non-empty string.`, pointer, nodeId));
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

export interface ValidateForEachOptions {
  pointer?: string;
  parentAllowed?: Iterable<string>;
  fileId?: string;
  projectKind?: ValidationContext["projectKind"];
  validateBody?: LoopBodyValidator;
}

/**
 * Validate a foreach node in isolation (raw snapshot friendly). `parentAllowed`
 * defaults to `{ start }`. Returns all issues. Body children reuse the shared
 * single-node validator via validate-node.ts.
 */
export function validateForEachNode(value: unknown, opts: ValidateForEachOptions = {}): Issue[] {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const addError = (i: Issue): void => void errors.push(i);
  const addWarning = (i: Issue): void => void warnings.push(i);
  const pointer = opts.pointer ?? "/graph/nodes/foreach";
  const parentAllowed = new Set<string>(opts.parentAllowed ?? ["start"]);
  if (!isRecord(value)) {
    addError(err("E_FOREACH_INVALID", "ForEach node must be an object.", pointer));
    return [...errors, ...warnings];
  }
  const nodeId = typeof value.id === "string" ? value.id : "foreach";
  if (value.type !== "foreach") {
    addError(
      err("E_FOREACH_INVALID", "ForEach node type must be 'foreach'.", `${pointer}/type`, nodeId),
    );
    return [...errors, ...warnings];
  }
  validateNodeBase(value, pointer, addError);

  const maxItems = value.maxItems ?? FOREACH_DEFAULT_MAX_ITEMS;
  if (
    typeof maxItems !== "number" ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < FOREACH_MIN_ITEMS ||
    maxItems > FOREACH_MAX_ITEMS
  ) {
    addError(
      err(
        "E_FOREACH_MAX_ITEMS",
        `ForEach maxItems must be an integer between ${FOREACH_MIN_ITEMS} and ${FOREACH_MAX_ITEMS}.`,
        `${pointer}/maxItems`,
        nodeId,
      ),
    );
  }
  const onItemFailure = value.onItemFailure ?? "stop";
  if (onItemFailure !== "stop" && onItemFailure !== "continue") {
    addError(
      err(
        "E_FOREACH_ON_ITEM_FAILURE",
        `ForEach onItemFailure must be 'stop' or 'continue'.`,
        `${pointer}/onItemFailure`,
        nodeId,
      ),
    );
  }

  const source = value.source as ForEachNode["source"] | undefined;
  if (!isRecord(source) || (source.kind !== "expression" && source.kind !== "csv")) {
    addError(
      err(
        "E_FOREACH_SOURCE",
        "ForEach source must be { kind: 'expression', expression } or { kind: 'csv', path }.",
        `${pointer}/source`,
        nodeId,
      ),
    );
  } else if (source.kind === "expression") {
    checkExpression(
      (source as { expression?: unknown }).expression,
      parentAllowed,
      `${pointer}/source/expression`,
      nodeId,
      "source.expression",
      addError,
      "E_FOREACH_SOURCE",
    );
  } else {
    const path = (source as { path?: unknown }).path;
    if (typeof path !== "string" || path.trim() === "") {
      addError(
        err(
          "E_FOREACH_SOURCE",
          "ForEach csv path must be a non-empty template.",
          `${pointer}/source/path`,
          nodeId,
        ),
      );
    } else {
      // CSV path is a template relative to the workspace, evaluated in parent scope.
      const compiled = compileTemplate(path, { shell: false });
      if (!compiled.ok) {
        const detail =
          isRecord(compiled.error.details) && typeof compiled.error.details.pointer === "string"
            ? compiled.error.details.pointer
            : "";
        addError(err("E_EXPR", compiled.error.message, `${pointer}/source/path${detail}`, nodeId));
      } else {
        for (const part of compiled.value.parts) {
          if (part.kind !== "expression") continue;
          rootsIn(
            part.compiled.roots,
            parentAllowed,
            `${pointer}/source/path`,
            nodeId,
            `source.path: {{ ${part.source} }}`,
            addError,
          );
        }
      }
      if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
        addError(
          err(
            "E_FOREACH_SOURCE",
            "ForEach csv path must be a relative workspace path (no leading /, .. or backslashes).",
            `${pointer}/source/path`,
            nodeId,
          ),
        );
      }
    }
  }

  if (value.output === undefined || !isRecord(value.output)) {
    addError(
      err(
        "E_OUTPUT_SCHEMA",
        "ForEach output must be a JSON schema object.",
        `${pointer}/output`,
        nodeId,
      ),
    );
  } else {
    const normalized = normalizeOutputSchema(value.output as import("./types.js").JsonSchemaObject);
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
        "E_FOREACH_BODY",
        "ForEach body must be an object with nodes and edges arrays.",
        `${pointer}/body`,
        nodeId,
      ),
    );
  } else {
    const topology = validateControllerTopology(
      body,
      pointer,
      nodeId,
      FOREACH_RESERVED_BODY_IDS,
      "ForEach",
      addError,
    );
    if (topology !== undefined) {
      endAncestors = topology.endAncestors;
      scopeOf = topology.scopeOf;
      bodyGraph = body;
    }
  }

  const resultScope = new Set<string>(["start", "foreach", ...endAncestors]);
  const foreachReferenced = new Set<string>();
  const collectRoots = (expr: unknown): void => {
    if (typeof expr !== "string" || expr.trim() === "") return;
    const compiled = compileExpression(expr);
    if (compiled.ok) for (const root of compiled.value.roots) foreachReferenced.add(root);
  };

  if (typeof value.result !== "string" || (value.result as string).trim() === "") {
    addError(
      err(
        "E_FOREACH_RESULT",
        "ForEach result must be a non-empty expression.",
        `${pointer}/result`,
        nodeId,
      ),
    );
  } else {
    checkExpression(
      value.result,
      resultScope,
      `${pointer}/result`,
      nodeId,
      "result",
      addError,
      "E_FOREACH_RESULT",
    );
    collectRoots(value.result);
  }
  if (source?.kind === "expression") collectRoots((source as { expression?: unknown }).expression);

  if (bodyGraph !== undefined && scopeOf !== undefined) {
    const validator = opts.validateBody ?? defaultControllerBodyValidator;
    validator(bodyGraph, scopeOf, pointer, nodeId, foreachReferenced, addError, addWarning, opts);
  }
  return [...errors, ...warnings];
}

export function validateForEachForWorkflow(
  node: import("./types.js").WorkflowNode,
  pointer: string,
  parentAllowed: Set<string>,
  addError: (item: Issue) => void,
  addWarning: (item: Issue) => void = () => {},
  validateBody?: LoopBodyValidator,
  ctx?: ValidateForEachOptions,
): void {
  const issues = validateForEachNode(node as unknown, {
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
