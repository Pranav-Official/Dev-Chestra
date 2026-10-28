import type { WorkflowFile } from "@devchestra/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyExternalChange,
  createEditorState,
  executeCommand,
  loadState,
  markSavedState,
} from "./commands.js";
import { createDefaultNode } from "./graph.js";
import type {
  CommandOutcome,
  DocumentChange,
  EditorCommand,
  EditorSelection,
  EditorState,
  NodePatch,
  Position,
} from "./types.js";

export interface EditorModelActions {
  getFile(): WorkflowFile;
  getSelection(): EditorSelection;
  isDirty(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  apply(command: EditorCommand): CommandOutcome;
  /** Route `EditorCanvas.onChange` here so canvas edits join the same history. */
  applyDocumentChange(next: WorkflowFile, change: DocumentChange): CommandOutcome;
  addNode(type: string, position?: Position): CommandOutcome;
  updateNode(nodeId: string, patch: NodePatch): CommandOutcome;
  updateRouting(
    nodeId: string,
    patch: NodePatch,
    removeEdgeIds?: readonly string[],
  ): CommandOutcome;
  renameNode(nodeId: string, name: string): CommandOutcome;
  moveNode(nodeId: string, position: Position): CommandOutcome;
  moveNodes(positions: Readonly<Record<string, Position>>): CommandOutcome;
  connect(source: string, target: string): CommandOutcome;
  removeSelection(selection?: EditorSelection): CommandOutcome;
  undo(): CommandOutcome;
  redo(): CommandOutcome;
  load(file: WorkflowFile): void;
  markSaved(revision: number): void;
  select(selection: EditorSelection): void;
}

export type EditorModelState = EditorState & EditorModelActions;
export type EditorModel = StoreApi<EditorModelState> & EditorModelActions;

export function createEditorModel(file: WorkflowFile): EditorModel {
  const store = createStore<EditorModelState>((set, get) => ({
    ...createEditorState(file),
    getFile: () => get().file,
    getSelection: () => get().selection,
    isDirty: () => get().dirty,
    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
    apply: (command) => {
      const state = get();
      const outcome = executeCommand(state, command);
      if (outcome.state !== state) set(outcome.state);
      return outcome;
    },
    applyDocumentChange: (next, change) => {
      const state = get();
      const updated = applyExternalChange(state, next, change);
      if (updated !== state) set(updated);
      const changed = updated.revision !== state.revision;
      return { ok: true, state: updated, change: changed ? change : null };
    },
    addNode: (type, position) => {
      const node = createDefaultNode(type as string, get().file.graph.nodes, position);
      return get().apply({ kind: "addNode", node });
    },
    updateNode: (nodeId, patch) => get().apply({ kind: "updateNode", nodeId, patch }),
    updateRouting: (nodeId, patch, removeEdgeIds) =>
      get().apply({
        kind: "updateRouting",
        nodeId,
        patch,
        ...(removeEdgeIds === undefined ? {} : { removeEdgeIds }),
      }),
    renameNode: (nodeId, name) => get().apply({ kind: "renameNode", nodeId, name }),
    moveNode: (nodeId, position) => get().apply({ kind: "moveNode", nodeId, position }),
    moveNodes: (positions) => get().apply({ kind: "moveNodes", positions }),
    connect: (source, target) => get().apply({ kind: "connect", connection: { source, target } }),
    removeSelection: (selection = get().selection) => {
      if (selection?.kind === "node") {
        const outcome = get().apply({ kind: "removeNode", nodeId: selection.nodeId });
        if (outcome.ok) get().apply({ kind: "select", selection: null });
        return outcome;
      }
      if (selection?.kind === "edge") {
        const outcome = get().apply({ kind: "removeEdge", edgeId: selection.edgeId });
        if (outcome.ok) get().apply({ kind: "select", selection: null });
        return outcome;
      }
      return { ok: true, state: get(), change: null };
    },
    undo: () => get().apply({ kind: "undo" }),
    redo: () => get().apply({ kind: "redo" }),
    load: (next) => set(loadState(next)),
    markSaved: (revision) => set(markSavedState(get(), revision)),
    select: (selection) => {
      get().apply({ kind: "select", selection });
    },
  }));
  const actions: EditorModelActions = {
    getFile: () => store.getState().getFile(),
    getSelection: () => store.getState().getSelection(),
    isDirty: () => store.getState().isDirty(),
    canUndo: () => store.getState().canUndo(),
    canRedo: () => store.getState().canRedo(),
    apply: (command) => store.getState().apply(command),
    applyDocumentChange: (next, nextChange) =>
      store.getState().applyDocumentChange(next, nextChange),
    addNode: (type, position) => store.getState().addNode(type, position),
    updateNode: (nodeId, patch) => store.getState().updateNode(nodeId, patch),
    updateRouting: (nodeId, patch, removeEdgeIds) =>
      store.getState().updateRouting(nodeId, patch, removeEdgeIds),
    renameNode: (nodeId, name) => store.getState().renameNode(nodeId, name),
    moveNode: (nodeId, position) => store.getState().moveNode(nodeId, position),
    moveNodes: (positions) => store.getState().moveNodes(positions),
    connect: (source, target) => store.getState().connect(source, target),
    removeSelection: (selection) => store.getState().removeSelection(selection),
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),
    load: (next) => store.getState().load(next),
    markSaved: (revision) => store.getState().markSaved(revision),
    select: (selection) => store.getState().select(selection),
  };
  return Object.assign(store, actions);
}
