import type { Edge, WorkflowFile, WorkflowNode } from "@devchestra/schema";

export type EditorSelection =
  | { kind: "node"; nodeId: string }
  | { kind: "edge"; edgeId: string }
  | null;

export interface DocumentChange {
  layoutOnly: boolean;
  nodeId?: string;
}

export interface Position {
  x: number;
  y: number;
}

/** Inspector patches may carry any node field; id/type are preserved by the command. */
export type NodePatch = Partial<WorkflowNode>;

export type WorkflowMetaPatch = Partial<
  Pick<WorkflowFile, "name" | "description" | "budget" | "supervisor">
>;

export interface ConnectRequest {
  source: string;
  target: string;
}

export type EditorCommand =
  | { kind: "addNode"; node: WorkflowNode }
  | { kind: "removeNode"; nodeId: string }
  | { kind: "removeNodes"; nodeIds: readonly string[] }
  | { kind: "updateNode"; nodeId: string; patch: NodePatch }
  | {
      kind: "updateRouting";
      nodeId: string;
      patch: NodePatch;
      /** Edges removed atomically with the node patch (connected handle deletion). */
      removeEdgeIds?: readonly string[];
    }
  | { kind: "renameNode"; nodeId: string; name: string }
  | { kind: "moveNode"; nodeId: string; position: Position }
  | { kind: "moveNodes"; positions: Readonly<Record<string, Position>> }
  | { kind: "connect"; connection: ConnectRequest }
  | { kind: "removeEdge"; edgeId: string }
  | { kind: "updateWorkflow"; patch: WorkflowMetaPatch }
  | { kind: "select"; selection: EditorSelection }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "load"; file: WorkflowFile }
  | { kind: "markSaved"; revision: number };

export interface HistoryEntry {
  file: WorkflowFile;
  change: DocumentChange;
}

export interface EditorState {
  file: WorkflowFile;
  selection: EditorSelection;
  past: readonly HistoryEntry[];
  future: readonly HistoryEntry[];
  revision: number;
  savedRevision: number;
  dirty: boolean;
  lastChange: DocumentChange | null;
}

export type CommandOutcome =
  | {
      ok: true;
      state: EditorState;
      change: DocumentChange | null;
      edge?: Edge;
    }
  | { ok: false; state: EditorState; error: string };

export interface AddNodeResult {
  file: WorkflowFile;
  change: DocumentChange;
  nodeId: string;
}
