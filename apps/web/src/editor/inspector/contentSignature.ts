import type { WorkflowNode } from "@relay/schema";
import { stableStringify } from "./stableStringify.js";

/**
 * Content identity of a node, excluding canvas-only `ui` data. Used to tell
 * our own patch echo apart from an external edit, undo or document switch
 * without resetting in-progress form buffers on every keystroke.
 */
export function contentSignature(node: WorkflowNode): string {
  return stableStringify({ ...node, ui: undefined });
}
