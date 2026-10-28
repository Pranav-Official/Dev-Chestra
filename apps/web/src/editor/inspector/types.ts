import type { Edge, Issue, WorkflowNode } from "@devchestra/schema";

export interface BufferValidity {
  valid: boolean;
  reason?: string;
}

export interface InspectorProps {
  node: WorkflowNode | null;
  projectId?: string | undefined;
  issues: readonly Issue[];
  onPatch: (nodeId: string, patch: Partial<WorkflowNode>) => void;
  /** Current edges, used by Gate/Join handle editors and connection warnings. */
  edges?: readonly Edge[];
  /** Atomic node patch + connected-edge removal for handle identity edits. */
  onRoutingChange?: (
    nodeId: string,
    patch: Partial<WorkflowNode>,
    removeEdgeIds: readonly string[],
  ) => void;
  onBufferValidityChange?: (state: BufferValidity) => void;
}

/** Internal patch shape: optional top-level fields may also be removed. */
export type PatchOf<T extends WorkflowNode> = {
  [K in keyof T]?: T[K] | undefined;
};

export interface FormProps<T extends WorkflowNode> {
  node: T;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<T>) => void;
}

export interface RoutingFormProps<T extends WorkflowNode> extends FormProps<T> {
  edges: readonly Edge[];
  onRoutingChange: (patch: Partial<WorkflowNode>, removeEdgeIds?: readonly string[]) => void;
}
