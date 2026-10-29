import type { DevChestraError } from "@devchestra/core";
import { analyzeGraph } from "./graph.js";
import { WORKFLOW_ID_PATTERN } from "./ids.js";
import { joinOutputIssues } from "./join.js";
import { validateLoopForWorkflow } from "./loop.js";
import { buildRequires } from "./requires.js";
import { compileTemplate } from "./template.js";
import type {
  Issue,
  ValidationContext,
  ValidationReport,
  WorkflowFile,
  WorkflowNode,
} from "./types.js";
import { validateSingleNode } from "./validate-node.js";
import { devchestraIssue, isRecord, issue } from "./validate-support.js";

export function validateWorkflow(
  file: WorkflowFile,
  ctx: ValidationContext = {},
): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const referencedRoots = new Set<string>();
  const addError = (item: Issue): void => void errors.push(item);
  const addWarning = (item: Issue): void => void warnings.push(item);
  const addDevChestra = (error: DevChestraError, pointer: string, nodeId?: string): void =>
    addError(devchestraIssue(error, pointer, nodeId));
  if (!isRecord(file) || !isRecord(file.graph)) {
    return {
      ok: false,
      errors: [issue("error", "E_WORKFLOW_INVALID", "Workflow graph is missing or malformed.")],
      warnings: [],
      requires: buildRequires([]),
    };
  }
  if (file.schemaVersion !== 1) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_INVALID",
        `Unsupported schemaVersion ${String(file.schemaVersion)}; this build supports 1.`,
        "/schemaVersion",
      ),
    );
  }
  if (typeof file.id !== "string" || !WORKFLOW_ID_PATTERN.test(file.id)) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_ID",
        `Workflow id '${String(file.id)}' must match ${WORKFLOW_ID_PATTERN.source} and equal the file stem.`,
        "/id",
      ),
    );
  }
  if (typeof file.name !== "string" || file.name.trim() === "" || file.name.length > 200) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_NAME",
        "Workflow name must be a non-empty string (max 200).",
        "/name",
      ),
    );
  }
  if (file.budget !== undefined) {
    const defined = Object.entries(file.budget).filter(([, value]) => value !== undefined);
    if (defined.length > 0) {
      addError(
        issue(
          "error",
          "E_WORKFLOW_INVALID",
          `Workflow budgets are not implemented in P1 and would be ignored (${defined
            .map(([key]) => key)
            .join(", ")}). Remove the budget block; enforcement belongs to the engine.`,
          "/budget",
        ),
      );
    }
  }
  if (file.supervisor !== undefined) {
    addError(
      issue(
        "error",
        "E_WORKFLOW_INVALID",
        "supervisor is not implemented in P1; remove the supervisor block.",
        "/supervisor",
      ),
    );
  }
  if (!Array.isArray(file.graph.nodes) || !Array.isArray(file.graph.edges)) {
    return {
      ok: false,
      errors: [
        ...errors,
        issue(
          "error",
          "E_WORKFLOW_INVALID",
          "graph.nodes and graph.edges must be arrays.",
          "/graph",
        ),
      ],
      warnings,
      requires: buildRequires([]),
    };
  }
  const nodes = file.graph.nodes as WorkflowNode[];
  const { analysis, issues: graphIssues } = analyzeGraph(file.graph);
  for (const graphIssue of graphIssues) addError(graphIssue);
  const checkRoots = (
    roots: readonly string[],
    allowed: Set<string>,
    pointer: string,
    nodeId: string,
    expression: string,
  ): void => {
    for (const root of roots) {
      referencedRoots.add(root);
      if (!allowed.has(root)) {
        const list = [...allowed].sort().join(", ");
        addError(
          issue(
            "error",
            "E_EXPR_SCOPE",
            `Expression root '${root}' is not in scope. Allowed: ${list || "(none)"}. Expression: ${expression}`,
            pointer,
            nodeId,
          ),
        );
      }
    }
  };
  const checkTemplate = (
    node: WorkflowNode,
    template: string,
    allowed: Set<string>,
    pointer: string,
    shell: boolean,
    label: string,
  ): void => {
    const compiled = compileTemplate(template, { shell });
    if (!compiled.ok) {
      addDevChestra(compiled.error, pointer, node.id);
      return;
    }
    for (const part of compiled.value.parts) {
      if (part.kind !== "expression") continue;
      checkRoots(part.compiled.roots, allowed, pointer, node.id, `${label}: {{ ${part.source} }}`);
    }
  };
  // Ordinary per-node rules live in validate-node.ts (shared with loop bodies,
  // so MCP/permission/context/limit/shell checks behave identically inside
  // bodies). Loop topology/boundary/state rules live in loop.ts.
  const helpers = {
    checkRoots,
    checkTemplate,
    addError,
    addWarning,
    addDevChestra,
    fileId: file.id,
    ctx,
  };
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const pointer = `/graph/nodes/${index}`;
    const allowed = new Set<string>(["start", ...analysis.ancestors(node.id)]);
    if (node.type === "loop") {
      validateLoopForWorkflow(node, pointer, allowed, addError, addWarning, undefined, {
        fileId: file.id,
        ...(ctx.projectKind === undefined ? {} : { projectKind: ctx.projectKind }),
      });
      continue;
    }
    validateSingleNode(node, pointer, allowed, helpers);
  }

  nodes.forEach((node, index) => {
    if (node.type !== "join") return;
    const report = joinOutputIssues(file.graph, node, index, referencedRoots.has(node.id));
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    requires: buildRequires(nodes, file.budget),
  };
}
