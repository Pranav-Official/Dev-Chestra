import { analyzeGraph } from "./graph.js";
import type { LoopBodyValidator, ValidateLoopOptions } from "./loop.js";
import type { Graph, Issue, WorkflowNode } from "./types.js";
import { validateLoopBodyChildren } from "./validate-node.js";
import { isRecord, issue } from "./validate-support.js";

/** Ordinary body children: ordinary nodes + workflow calls, no loop/foreach nesting v1. */
export const CONTROLLER_BODY_SUPPORTED = new Set([
  "start",
  "agent",
  "shell",
  "gate",
  "join",
  "approval",
  "decision",
  "workflow",
  "end",
]);

function err(code: string, message: string, pointer: string, nodeId?: string): Issue {
  return issue("error", code, message, pointer, nodeId);
}

export interface ControllerTopology {
  endAncestors: Set<string>;
  scopeOf: (nodeId: string) => Set<string>;
}

/**
 * Shared controller-body topology for loop + foreach. Avoids a massive copy:
 * reserved-id guard, nesting guard, structural analysis, exactly-one start/end,
 * success-only end, empty start params, scratch-only child workspaces.
 * `reservedIds` is LOOP_RESERVED_BODY_IDS or FOREACH_RESERVED_BODY_IDS;
 * `label` names the controller in messages ("Loop"/"ForEach").
 */
export function validateControllerTopology(
  body: Graph,
  base: string,
  controllerId: string,
  reservedIds: readonly string[],
  label: string,
  addError: (item: Issue) => void,
): ControllerTopology | undefined {
  const nodes = body.nodes as WorkflowNode[];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as WorkflowNode;
    const at = `${base}/body/nodes/${index}`;
    const record = node as unknown as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id !== undefined && (reservedIds as readonly string[]).includes(id)) {
      addError(
        err(
          label === "ForEach" ? "E_FOREACH_BODY_ID" : "E_LOOP_BODY_ID",
          `Body node id '${id}' is reserved for ${label.toLowerCase()} scope.`,
          `${at}/id`,
          controllerId,
        ),
      );
    }
    if (record.type === "loop" || record.type === "foreach") {
      addError(
        err(
          label === "ForEach" ? "E_FOREACH_NESTED" : "E_LOOP_NESTED",
          `Nested controllers are not supported; ${label.toLowerCase()} bodies cannot contain loop/foreach nodes. Use a separate workflow with a loop.`,
          `${at}/type`,
          controllerId,
        ),
      );
    } else if (typeof record.type === "string" && !CONTROLLER_BODY_SUPPORTED.has(record.type)) {
      addError(
        err(
          "E_NODE_TYPE",
          `Unsupported body node type '${record.type}'.`,
          `${at}/type`,
          controllerId,
        ),
      );
    }
  }

  const { analysis, issues } = analyzeGraph(body);
  for (const item of issues) {
    const remapped =
      item.pointer === undefined ? undefined : item.pointer.replace(/^\/graph/, `${base}/body`);
    addError({ ...item, pointer: remapped ?? `${base}/body`, nodeId: item.nodeId ?? controllerId });
  }

  const starts = nodes.filter((node) => node.type === "start");
  const ends = nodes.filter((node) => node.type === "end");
  if (ends.length !== 1) {
    addError(
      err(
        label === "ForEach" ? "E_FOREACH_BODY" : "E_LOOP_BODY",
        `${label} body must have exactly one start and one end (found ${starts.length} start, ${ends.length} end).`,
        `${base}/body/nodes`,
        controllerId,
      ),
    );
  }
  const endNode = ends[0];
  if (endNode !== undefined && (endNode as { status?: unknown }).status !== "success") {
    const endIndex = nodes.indexOf(endNode);
    addError(
      err(
        label === "ForEach" ? "E_FOREACH_BODY_END_STATUS" : "E_LOOP_BODY_END_STATUS",
        `${label} body end status must be 'success'; failure/rejection ends the run, not a round/item.`,
        `${base}/body/nodes/${Math.max(endIndex, 0)}/status`,
        controllerId,
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
          label === "ForEach" ? "E_FOREACH_BODY_START_PARAMS" : "E_LOOP_BODY_START_PARAMS",
          `${label} body start params must be empty; parent inputs arrive via ${label.toLowerCase()}.parent.`,
          `${base}/body/nodes/${Math.max(startIndex, 0)}/params`,
          controllerId,
        ),
      );
    }
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as WorkflowNode;
    if (node.type !== "agent" && node.type !== "shell") continue;
    const workspace = (node as { workspace?: unknown }).workspace;
    if (workspace === undefined) continue;
    if (!isRecord(workspace) || workspace.mode !== "scratch") {
      addError(
        err(
          label === "ForEach" ? "E_FOREACH_BODY_WORKSPACE" : "E_LOOP_BODY_WORKSPACE",
          `${label} body children must use scratch workspaces.`,
          `${base}/body/nodes/${index}/workspace`,
          controllerId,
        ),
      );
    }
  }

  if (endNode === undefined) return undefined;
  const endAncestors = analysis.ancestors(endNode.id);
  const prefix = label.toLowerCase();
  const scopeOf = (id: string): Set<string> =>
    new Set<string>(["start", prefix, ...analysis.ancestors(id)]);
  return { endAncestors, scopeOf };
}

/** Shared default body-child validator (ordinary rules via validate-node.ts). */
export function defaultControllerBodyValidator(
  body: Graph,
  scopeOf: (nodeId: string) => Set<string>,
  base: string,
  _controllerId: string,
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

// Re-export the loop validator type shape for foreach reuse without a cycle.
export type { LoopBodyValidator };
