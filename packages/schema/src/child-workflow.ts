import { compileExpression } from "./expression.js";
import { WORKFLOW_ID_PATTERN } from "./ids.js";
import { normalizeOutputSchema } from "./output-schema.js";
import type { ChildWorkflowNode, Issue, JsonSchemaObject, ValidationContext } from "./types.js";
import { validateNodeBase } from "./validate-node.js";
import { isRecord, issue } from "./validate-support.js";

export { workflowEnvelopeSchema } from "./workflow-envelope.js";

function err(code: string, message: string, pointer: string, nodeId?: string): Issue {
  return issue("error", code, message, pointer, nodeId);
}

export interface ValidateChildWorkflowOptions {
  pointer?: string;
  /** Parent scope roots for input expressions (start + ancestors). */
  parentAllowed?: Iterable<string>;
  /** Target start params when the callee definition is resolved; skips key checks otherwise. */
  targetParams?: readonly { name: string }[] | undefined;
  fileId?: string;
  projectKind?: ValidationContext["projectKind"];
}

/**
 * Validate a `workflow` (child-workflow call) node in isolation.
 * Input keys are checked against `targetParams` only when definitions resolve;
 * run preparation performs static missing-definition/cycle checks separately
 * (engine owns the canonical freeze; schema never reads the filesystem).
 */
export function validateChildWorkflowNode(
  value: unknown,
  opts: ValidateChildWorkflowOptions = {},
): Issue[] {
  const errors: Issue[] = [];
  const addError = (i: Issue): void => void errors.push(i);
  const pointer = opts.pointer ?? "/graph/nodes/workflow";
  const parentAllowed = new Set<string>(opts.parentAllowed ?? ["start"]);
  if (!isRecord(value)) {
    addError(err("E_WORKFLOW_NODE_INVALID", "Workflow node must be an object.", pointer));
    return errors;
  }
  const nodeId = typeof value.id === "string" ? value.id : "workflow";
  if (value.type !== "workflow") {
    addError(
      err(
        "E_WORKFLOW_NODE_INVALID",
        "Workflow node type must be 'workflow'.",
        `${pointer}/type`,
        nodeId,
      ),
    );
    return errors;
  }
  validateNodeBase(value, pointer, addError);
  const node = value as Partial<ChildWorkflowNode> & Record<string, unknown>;

  if (typeof node.workflowId !== "string" || !WORKFLOW_ID_PATTERN.test(node.workflowId)) {
    addError(
      err(
        "E_WORKFLOW_NODE_ID",
        `Workflow node workflowId must match ${WORKFLOW_ID_PATTERN.source} (same managed-workflow rules).`,
        `${pointer}/workflowId`,
        nodeId,
      ),
    );
  }
  if (!isRecord(node.inputs)) {
    addError(
      err(
        "E_WORKFLOW_NODE_INPUTS",
        "Workflow node inputs must be an object.",
        `${pointer}/inputs`,
        nodeId,
      ),
    );
  } else {
    const inputs = node.inputs as Record<string, unknown>;
    if (opts.targetParams !== undefined) {
      const known = new Set(opts.targetParams.map((p) => p.name));
      for (const key of Object.keys(inputs)) {
        if (!known.has(key)) {
          addError(
            err(
              "E_WORKFLOW_NODE_INPUTS",
              `Workflow input '${key}' is not a param of target workflow '${String(node.workflowId)}'.`,
              `${pointer}/inputs/${key}`,
              nodeId,
            ),
          );
        }
      }
    }
    for (const [key, expr] of Object.entries(inputs)) {
      if (typeof expr !== "string" || expr.trim() === "") {
        addError(
          err(
            "E_WORKFLOW_NODE_INPUTS",
            `Workflow input '${key}' must be a non-empty JSONata expression.`,
            `${pointer}/inputs/${key}`,
            nodeId,
          ),
        );
        continue;
      }
      const compiled = compileExpression(expr);
      if (!compiled.ok) {
        const detail =
          isRecord(compiled.error.details) && typeof compiled.error.details.pointer === "string"
            ? compiled.error.details.pointer
            : "";
        addError(
          err("E_EXPR", compiled.error.message, `${pointer}/inputs/${key}${detail}`, nodeId),
        );
        continue;
      }
      for (const root of compiled.value.roots) {
        if (!parentAllowed.has(root)) {
          const list = [...parentAllowed].sort().join(", ");
          addError(
            err(
              "E_EXPR_SCOPE",
              `Expression root '${root}' is not in scope. Allowed: ${list || "(none)"}. Expression: inputs.${key}: ${expr}`,
              `${pointer}/inputs/${key}`,
              nodeId,
            ),
          );
        }
      }
    }
  }
  if (node.output !== undefined) {
    if (!isRecord(node.output)) {
      addError(
        err(
          "E_OUTPUT_SCHEMA",
          "Workflow output must be a JSON schema object.",
          `${pointer}/output`,
          nodeId,
        ),
      );
    } else {
      const normalized = normalizeOutputSchema(node.output as JsonSchemaObject);
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
  }
  return errors;
}

export function validateChildWorkflowForWorkflow(
  node: import("./types.js").WorkflowNode,
  pointer: string,
  parentAllowed: Set<string>,
  addError: (item: Issue) => void,
  targetParams?: readonly { name: string }[] | undefined,
): void {
  for (const item of validateChildWorkflowNode(node as unknown, {
    pointer,
    parentAllowed,
    targetParams,
  })) {
    addError(item);
  }
}
