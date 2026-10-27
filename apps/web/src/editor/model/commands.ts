import type { Edge, WorkflowFile, WorkflowNode } from "@relay/schema";
import {
  checkConnection,
  createDefaultNode,
  createEdgeId,
  isSupportedNodeType,
  nodeIdOfEndpoint,
  snapPosition,
  withPosition,
} from "./graph.js";
import { danglingHandleProblem } from "./routing.js";
import type {
  AddNodeResult,
  CommandOutcome,
  DocumentChange,
  EditorCommand,
  EditorSelection,
  EditorState,
  NodePatch,
  Position,
} from "./types.js";

export const HISTORY_LIMIT = 100;

function change(layoutOnly: boolean, nodeId?: string): DocumentChange {
  return nodeId === undefined ? { layoutOnly } : { layoutOnly, nodeId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createEditorState(file: WorkflowFile): EditorState {
  return {
    file,
    selection: null,
    past: [],
    future: [],
    revision: 0,
    savedRevision: 0,
    dirty: false,
    lastChange: null,
  };
}

export function loadState(file: WorkflowFile): EditorState {
  return createEditorState(file);
}

export function markSavedState(state: EditorState, revision: number): EditorState {
  if (!Number.isSafeInteger(revision) || revision < 0) return state;
  const acked = Math.min(revision, state.revision);
  if (acked <= state.savedRevision) return state;
  return {
    ...state,
    savedRevision: acked,
    dirty: state.revision !== acked,
  };
}

export function reconcileSelection(
  selection: EditorSelection,
  file: WorkflowFile,
): EditorSelection {
  if (selection === null) return null;
  if (selection.kind === "node") {
    return file.graph.nodes.some((node) => node.id === selection.nodeId) ? selection : null;
  }
  return file.graph.edges.some((edge) => edge.id === selection.edgeId) ? selection : null;
}

export function sameSelection(left: EditorSelection, right: EditorSelection): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "node" && right.kind === "node") return left.nodeId === right.nodeId;
  if (left.kind === "edge" && right.kind === "edge") return left.edgeId === right.edgeId;
  return false;
}

function commit(state: EditorState, file: WorkflowFile, nextChange: DocumentChange): EditorState {
  const revision = state.revision + 1;
  const past = [...state.past, { file: state.file, change: nextChange }].slice(-HISTORY_LIMIT);
  return {
    ...state,
    file,
    selection: reconcileSelection(state.selection, file),
    past,
    future: [],
    revision,
    dirty: revision !== state.savedRevision,
    lastChange: nextChange,
  };
}

/** Record a full document produced outside the model (Canvas onChange, palette). */
export function applyExternalChange(
  state: EditorState,
  next: WorkflowFile,
  nextChange: DocumentChange,
): EditorState {
  if (next.id !== state.file.id) return loadState(next);
  if (sameJson(next, state.file)) return state;
  return commit(state, next, nextChange);
}

function moveNodeValue(node: WorkflowNode, position: Position): WorkflowNode {
  const at = snapPosition(position);
  return { ...node, ui: withPosition(node.ui, at) } as WorkflowNode;
}

function updateNodeValue(node: WorkflowNode, patch: NodePatch): WorkflowNode {
  const record = patch as Record<string, unknown>;
  const next = { ...node, ...record, id: node.id, type: node.type } as WorkflowNode;
  if (isRecord(record.ui)) {
    next.ui = { ...(node.ui ?? {}), ...record.ui };
  }
  return next;
}

function patchIsLayoutOnly(patch: NodePatch): boolean {
  const record = patch as Record<string, unknown>;
  const keys = Object.keys(record);
  const ui = record.ui;
  if (keys.length !== 1 || keys[0] !== "ui" || !isRecord(ui)) return false;
  const uiKeys = Object.keys(ui);
  return (
    uiKeys.length > 0 &&
    uiKeys.every((key) => key === "x" || key === "y") &&
    uiKeys.every((key) => typeof ui[key] === "number")
  );
}

function updateNodeState(state: EditorState, nodeId: string, patch: NodePatch): CommandOutcome {
  const index = state.file.graph.nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) return { ok: false, state, error: `Node '${nodeId}' does not exist.` };
  const node = state.file.graph.nodes[index];
  if (node === undefined) return { ok: false, state, error: `Node '${nodeId}' does not exist.` };
  const next = updateNodeValue(node, patch);
  if (sameJson(next, node)) return { ok: true, state, change: null };
  const nodes = [...state.file.graph.nodes];
  nodes[index] = next;
  const file = { ...state.file, graph: { ...state.file.graph, nodes } };
  return {
    ok: true,
    state: commit(state, file, change(patchIsLayoutOnly(patch), nodeId)),
    change: change(patchIsLayoutOnly(patch), nodeId),
  };
}

function removeNodesState(state: EditorState, nodeIds: readonly string[]): CommandOutcome {
  const ids = new Set(nodeIds);
  const nodes = state.file.graph.nodes.filter((node) => !ids.has(node.id));
  if (nodes.length === state.file.graph.nodes.length) {
    return { ok: true, state, change: null };
  }
  const edges = state.file.graph.edges.filter(
    (edge) => !ids.has(nodeIdOfEndpoint(edge.from)) && !ids.has(nodeIdOfEndpoint(edge.to)),
  );
  const file = { ...state.file, graph: { nodes, edges } };
  const nodeId = nodeIds.length === 1 ? nodeIds[0] : undefined;
  const nextChange = change(false, nodeId);
  return { ok: true, state: commit(state, file, nextChange), change: nextChange };
}

export function executeCommand(state: EditorState, command: EditorCommand): CommandOutcome {
  switch (command.kind) {
    case "addNode": {
      if (state.file.graph.nodes.some((node) => node.id === command.node.id)) {
        return {
          ok: false,
          state,
          error: `Node id '${command.node.id}' is already in use.`,
        };
      }
      if (!isSupportedNodeType(command.node.type)) {
        return { ok: false, state, error: "That node type cannot be added in this editor." };
      }
      const file = {
        ...state.file,
        graph: {
          ...state.file.graph,
          nodes: [...state.file.graph.nodes, command.node],
        },
      };
      const nextChange = change(false, command.node.id);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange };
    }

    case "removeNode":
      return removeNodesState(state, [command.nodeId]);

    case "removeNodes":
      return removeNodesState(state, command.nodeIds);

    case "updateNode":
      return updateNodeState(state, command.nodeId, command.patch);

    case "renameNode":
      return updateNodeState(state, command.nodeId, { name: command.name } as NodePatch);
    case "updateRouting": {
      const index = state.file.graph.nodes.findIndex((node) => node.id === command.nodeId);
      const node = state.file.graph.nodes[index];
      if (node === undefined) {
        return { ok: false, state, error: `Node '${command.nodeId}' does not exist.` };
      }
      const next = updateNodeValue(node, command.patch);
      const remove = new Set(command.removeEdgeIds ?? []);
      const edges = state.file.graph.edges.filter((edge) => !remove.has(edge.id));
      const handleProblem = danglingHandleProblem(node, next, edges);
      if (handleProblem !== null) return { ok: false, state, error: handleProblem };
      if (sameJson(next, node) && edges.length === state.file.graph.edges.length) {
        return { ok: true, state, change: null };
      }
      const nodes = [...state.file.graph.nodes];
      nodes[index] = next;
      const file = { ...state.file, graph: { nodes, edges } };
      const nextChange = change(false, command.nodeId);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange };
    }

    case "moveNode": {
      const index = state.file.graph.nodes.findIndex((node) => node.id === command.nodeId);
      if (index === -1) {
        return { ok: false, state, error: `Node '${command.nodeId}' does not exist.` };
      }
      const node = state.file.graph.nodes[index];
      if (node === undefined) {
        return { ok: false, state, error: `Node '${command.nodeId}' does not exist.` };
      }
      const next = moveNodeValue(node, command.position);
      if (sameJson(next, node)) return { ok: true, state, change: null };
      const nodes = [...state.file.graph.nodes];
      nodes[index] = next;
      const file = { ...state.file, graph: { ...state.file.graph, nodes } };
      const nextChange = change(true, command.nodeId);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange };
    }

    case "moveNodes": {
      const nodes = [...state.file.graph.nodes];
      let changed = 0;
      let changedId: string | undefined;
      nodes.forEach((node, index) => {
        const position = command.positions[node.id];
        if (position === undefined) return;
        const next = moveNodeValue(node, position);
        if (sameJson(next, node)) return;
        nodes[index] = next;
        changed += 1;
        changedId = node.id;
      });
      if (changed === 0) return { ok: true, state, change: null };
      const file = { ...state.file, graph: { ...state.file.graph, nodes } };
      const nextChange = change(true, changed === 1 ? changedId : undefined);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange };
    }

    case "connect": {
      const checked = checkConnection(state.file, command.connection);
      if (!checked.ok) {
        return {
          ok: false,
          state,
          error: checked.message ?? "That connection is not allowed.",
        };
      }
      const edge: Edge = {
        id: createEdgeId(
          command.connection.source,
          command.connection.target,
          state.file.graph.edges,
        ),
        from: command.connection.source,
        to: command.connection.target,
      };
      const file = {
        ...state.file,
        graph: {
          ...state.file.graph,
          edges: [...state.file.graph.edges, edge],
        },
      };
      const nextChange = change(false);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange, edge };
    }

    case "removeEdge": {
      const edges = state.file.graph.edges.filter((edge) => edge.id !== command.edgeId);
      if (edges.length === state.file.graph.edges.length) {
        return { ok: false, state, error: `Connection '${command.edgeId}' does not exist.` };
      }
      const file = { ...state.file, graph: { ...state.file.graph, edges } };
      const nextChange = change(false);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange };
    }

    case "updateWorkflow": {
      const record = command.patch as Record<string, unknown>;
      if ("id" in record || "schemaVersion" in record || "graph" in record) {
        return { ok: false, state, error: "Workflow identity and graph cannot be patched." };
      }
      const file = { ...state.file, ...record } as WorkflowFile;
      if (sameJson(file, state.file)) return { ok: true, state, change: null };
      const nextChange = change(false);
      return { ok: true, state: commit(state, file, nextChange), change: nextChange };
    }

    case "select": {
      const selection = reconcileSelection(command.selection, state.file);
      if (sameSelection(selection, state.selection)) return { ok: true, state, change: null };
      return { ok: true, state: { ...state, selection }, change: null };
    }

    case "undo": {
      const entry = state.past.at(-1);
      if (entry === undefined) return { ok: true, state, change: null };
      const past = state.past.slice(0, -1);
      const future = [...state.future, { file: state.file, change: entry.change }].slice(
        -HISTORY_LIMIT,
      );
      const revision = state.revision + 1;
      const next: EditorState = {
        ...state,
        file: entry.file,
        selection: reconcileSelection(state.selection, entry.file),
        past,
        future,
        revision,
        dirty: revision !== state.savedRevision,
        lastChange: entry.change,
      };
      return { ok: true, state: next, change: entry.change };
    }

    case "redo": {
      const entry = state.future.at(-1);
      if (entry === undefined) return { ok: true, state, change: null };
      const future = state.future.slice(0, -1);
      const past = [...state.past, { file: state.file, change: entry.change }].slice(
        -HISTORY_LIMIT,
      );
      const revision = state.revision + 1;
      const next: EditorState = {
        ...state,
        file: entry.file,
        selection: reconcileSelection(state.selection, entry.file),
        past,
        future,
        revision,
        dirty: revision !== state.savedRevision,
        lastChange: entry.change,
      };
      return { ok: true, state: next, change: entry.change };
    }

    case "load":
      return { ok: true, state: loadState(command.file), change: null };

    case "markSaved":
      return { ok: true, state: markSavedState(state, command.revision), change: null };
  }
}

export function applyCommandToFile(file: WorkflowFile, command: EditorCommand): CommandOutcome {
  return executeCommand(createEditorState(file), command);
}

export function addNodeToFile(
  file: WorkflowFile,
  type: Parameters<typeof createDefaultNode>[0],
  position?: Position,
): AddNodeResult | null {
  const node = createDefaultNode(type, file.graph.nodes, position);
  const outcome = applyCommandToFile(file, { kind: "addNode", node });
  if (!outcome.ok || outcome.change === null) return null;
  return { file: outcome.state.file, change: outcome.change, nodeId: node.id };
}
