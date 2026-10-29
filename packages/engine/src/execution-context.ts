import {
  DevChestraError,
  type CaptureEntry,
  type ExecutionContextRef,
  type LoopView,
  type Path,
  type RunId,
} from "@devchestra/core";
import type { RunRecord, Store } from "@devchestra/store";
import { decisionScopeValue, type EngineContext } from "./context.js";
import type { WorkflowPlan } from "./graph-plan.js";

/**
 * Runtime use of reference-backed loop-parent captures (Part A).
 *
 * Verification and hydration are centralized in the store
 * (`contextCaptures.resolve`); this module adds a run-scoped cache with a
 * bounded lifecycle plus the single ancestor-walk shared by capture creation
 * and initial-state evaluation.
 *
 * Secret policy: values are scanned authoritatively at capture creation and
 * are immutable afterwards, so resolution verifies ownership and content
 * identity but does not rescan. Cached scopes are frozen clones; cache hits
 * recheck run ownership. Terminal runs evict their entries (see
 * EngineContext.releaseRunContext, called on run completion/failure);
 * paused/resumable runs retain theirs.
 */

export class ExecutionContextCache {
  readonly #resolved = new Map<string, { runId: string; scope: Record<string, unknown> }>();

  get(captureId: string, runId: string): Record<string, unknown> | undefined {
    const entry = this.#resolved.get(captureId);
    if (!entry || (entry.runId as string) !== (runId as string)) return undefined;
    return structuredClone(entry.scope);
  }

  set(captureId: string, runId: string, scope: Record<string, unknown>): void {
    this.#resolved.set(captureId, { runId: runId as string, scope: structuredClone(scope) });
    if (this.#resolved.size > 200) {
      const first = this.#resolved.keys().next();
      if (!first.done) this.#resolved.delete(first.value);
    }
  }

  evictRun(runId: string): void {
    for (const [key, entry] of this.#resolved) {
      if ((entry.runId as string) === (runId as string)) this.#resolved.delete(key);
    }
  }

  clear(): void {
    this.#resolved.clear();
  }
}

function fail(code: "E_INTERNAL" | "E_NOT_FOUND" | "E_FORBIDDEN_PATH", message: string, details?: unknown): never {
  throw new DevChestraError(code, message, details === undefined ? {} : { details });
}

/** Verified hydration through the store; cached per run with ownership checks. */
export function resolveCaptureScope(
  store: Store,
  run: RunRecord,
  captureId: string,
  cache?: ExecutionContextCache,
): Record<string, unknown> {
  const cached = cache?.get(captureId, run.id as string);
  if (cached) return cached;
  let scope: Record<string, unknown>;
  try {
    scope = store.contextCaptures.resolve(run.id, captureId);
  } catch (error) {
    if (error instanceof DevChestraError) throw error;
    fail("E_NOT_FOUND", `Execution-context capture ${captureId} is missing or corrupt`, { captureId });
  }
  cache?.set(captureId, run.id as string, scope);
  return structuredClone(scope);
}

/** Resolve a LoopView's parent scope, supporting legacy inline parents. */
export function resolveLoopParent(
  store: Store,
  run: RunRecord,
  loop: LoopView,
  cache?: ExecutionContextCache,
): Record<string, unknown> {
  const ref = loop.parentRef as ExecutionContextRef | null;
  if (ref === null || ref === undefined) return { ...loop.parent };
  if (ref.kind !== "devchestra.execution-context/v1" || typeof ref.captureId !== "string") {
    fail("E_INTERNAL", "Loop parent reference is not a tagged execution-context reference");
  }
  return resolveCaptureScope(store, run, ref.captureId, cache);
}

export interface ParentContext {
  /** Hydrated scope; identical semantics to chainOutputs + buildScopeData. */
  scope: Record<string, unknown>;
  /** Reference-backed capture entries for the same ancestors. */
  entries: CaptureEntry[];
}

/**
 * Single ancestor walk shared by capture creation and initial-state
 * evaluation. Mirrors EngineContext.chainOutputs/ancestorValue semantics for
 * top-level plans (start params alias, skipped/failed → null, succeeded →
 * exact accepted output with the decision adapter, pending/running → throw).
 * The walk yields both the hydrated scope and the reference entries, so the
 * two can never diverge.
 */
export function collectParentContext(
  ctx: EngineContext,
  run: RunRecord,
  parentPlan: WorkflowPlan,
  nodeId: string,
): ParentContext {
  const scope: Record<string, unknown> = { start: { ...run.params } };
  const entries: CaptureEntry[] = [{ name: "start", type: "run-params" }];
  const seen = new Set<string>(["start"]);
  for (const id of parentPlan.ancestorsOf(nodeId)) {
    const execution = ctx.store.executions.get(run.id, id as Path);
    if (execution === null) {
      throw new DevChestraError("E_INTERNAL", `Ancestor '${id}' has no execution row`, {
        details: { runId: run.id },
      });
    }
    if (id === "start") {
      scope[id] = execution.status === "succeeded"
        ? (execution.kind === "decision"
            ? decisionScopeValue(ctx.output(run.id, id, execution.attempt)?.json)
            : ctx.output(run.id, id, execution.attempt)?.json)
        : null;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (execution.status === "skipped") {
      scope[id] = null;
      entries.push({ name: id, type: "literal", value: null });
      continue;
    }
    if (execution.status === "succeeded") {
      const output = ctx.store.outputs.get({ runId: run.id, path: id as Path, attempt: execution.attempt });
      if (output === null) {
        throw new DevChestraError("E_INTERNAL", `Ancestor '${id}' has no output for attempt ${execution.attempt}`, {
          details: { runId: run.id },
        });
      }
      scope[id] = execution.kind === "decision" ? decisionScopeValue(output.json) : output.json;
      entries.push({
        name: id,
        type: "output",
        outputId: output.id,
        path: id,
        attempt: execution.attempt,
        nodeKind: execution.kind,
        hash: output.hash,
      });
      continue;
    }
    if (execution.status === "failed" || execution.status === "rejected" || execution.status === "cancelled") {
      scope[id] = null;
      entries.push({ name: id, type: "literal", value: null });
      continue;
    }
    throw new DevChestraError(
      "E_INTERNAL",
      `Ancestor '${id}' is ${execution.status}; a ready node cannot use an unresolved ancestor`,
      { details: { runId: run.id, status: execution.status } },
    );
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { scope, entries };
}

export type { RunId };
