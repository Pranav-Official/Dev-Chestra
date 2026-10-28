import { DevChestraError } from "./error.js";
import type { RunId } from "./ids.js";
import type { Path } from "./path.js";

export interface ExecutionIdentity {
  readonly runId: RunId;
  readonly path: Path;
  readonly attempt: number;
  readonly generation: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DevChestraError(
      "E_VALIDATION",
      `${name} must be a positive integer, got ${String(value)}`,
    );
  }
}

export function createExecutionIdentity(
  runId: RunId,
  path: Path,
  attempt = 1,
  generation = 1,
): ExecutionIdentity {
  positiveInteger(attempt, "Logical attempt");
  positiveInteger(generation, "Process generation");
  return { runId, path, attempt, generation };
}

export function sameExecution(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return (
    left.runId === right.runId &&
    left.path === right.path &&
    left.attempt === right.attempt &&
    left.generation === right.generation
  );
}

/**
 * Authorization check for gateway/tool callbacks. Every component must match
 * exactly; a future generation, another attempt, another path or another run
 * is rejected.
 */
export function isCurrentInvocation(
  callback: ExecutionIdentity,
  current: ExecutionIdentity,
): boolean {
  return sameExecution(callback, current);
}

/**
 * Diagnostic helper only, never an authorization decision. It reports older
 * work or work from another execution. A future generation is not "stale" and
 * would still be rejected by isCurrentInvocation.
 */
export function isStaleCallback(callback: ExecutionIdentity, current: ExecutionIdentity): boolean {
  if (callback.runId !== current.runId || callback.path !== current.path) return true;
  if (callback.attempt < current.attempt) return true;
  return callback.attempt === current.attempt && callback.generation < current.generation;
}

export function nextGeneration(identity: ExecutionIdentity): ExecutionIdentity {
  positiveInteger(identity.attempt, "Logical attempt");
  positiveInteger(identity.generation, "Process generation");
  return { ...identity, generation: identity.generation + 1 };
}

export function nextAttempt(identity: ExecutionIdentity): ExecutionIdentity {
  positiveInteger(identity.attempt, "Logical attempt");
  positiveInteger(identity.generation, "Process generation");
  return { ...identity, attempt: identity.attempt + 1, generation: 1 };
}

/**
 * Receipt key for one tool call. A transport retry reuses the same key. A fresh
 * model call gets a new callId even when its arguments are identical.
 */
export interface ToolCallReceiptKey {
  readonly identity: ExecutionIdentity;
  readonly callId: string;
}

export function createToolCallReceiptKey(
  identity: ExecutionIdentity,
  callId: string,
): ToolCallReceiptKey {
  if (callId.length === 0) {
    throw new DevChestraError("E_VALIDATION", "Tool call receipt requires a non-empty callId");
  }
  return { identity, callId };
}

export function sameToolCallReceiptKey(
  left: ToolCallReceiptKey,
  right: ToolCallReceiptKey,
): boolean {
  return left.callId === right.callId && sameExecution(left.identity, right.identity);
}
