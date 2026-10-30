import {
  canonicalJson,
  DevChestraError,
  type ExecutionIdentity,
  type Path,
  type RunId,
} from "@devchestra/core";
import { compileExpression, evaluate, resolveParams } from "@devchestra/schema";
import type { RunRecord } from "@devchestra/store";
import type { ActiveRunState, EngineContext } from "./context.js";
import { toDevChestraError } from "./context.js";
import { bundleSnapshotFor } from "./freeze.js";
import type { PlanNode, WorkflowPlan } from "./graph-plan.js";
import { buildScopeData } from "./scope.js";
import { StopSignal } from "./stop.js";
import type { RunOutcome } from "./types.js";

export interface WorkflowDriver {
  /** Ensure the child run is driven; fresh=false reattaches after restart. */
  driveChild(childRunId: string, opts?: { fresh: boolean }): Promise<RunOutcome>;
  /** Best-effort cascade of a parent user-cancel to the active child. */
  cancelChild(childRunId: string): Promise<void>;
}

function checkStop(active: ActiveRunState): void {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
}

/** Depth of the parent chain via durable run_children links (root = 0). */
function parentDepth(ctx: EngineContext, runId: string): number {
  let depth = 0;
  let current: string | null = runId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const link = ctx.store.workflowCalls.getParent(current);
    if (!link) break;
    depth += 1;
    current = link.parentRunId as string;
    if (depth > 64) break;
  }
  return depth;
}

function ancestorWorkflowIds(ctx: EngineContext, runId: string): string[] {
  const ids: string[] = [];
  let current: string | null = runId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = ctx.store.runs.get(current as RunId);
    if (record) ids.push(record.workflowId);
    const link = ctx.store.workflowCalls.getParent(current);
    current = link ? (link.parentRunId as string) : null;
    if (ids.length > 64) break;
  }
  return ids;
}

/** Child start params from the frozen snapshot (validated via resolveParams before spawn). */
function childStartParams(snapshot: unknown): {
  params: import("@devchestra/schema").WorkflowParam[];
} {
  const graph = (snapshot as { graph?: { nodes?: unknown[] } })?.graph;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const start = nodes.find(
    (node): node is Record<string, unknown> =>
      typeof node === "object" && node !== null && (node as { type?: unknown }).type === "start",
  );
  const params = (start as { params?: unknown } | undefined)?.params;
  if (!Array.isArray(params)) return { params: [] };
  return {
    params: params.map((param) => {
      const record = param as Record<string, unknown>;
      if (typeof record.name !== "string") {
        throw new DevChestraError("E_WORKFLOW_INVALID", "Child start param is missing a name");
      }
      if (
        record.type !== "string" &&
        record.type !== "number" &&
        record.type !== "boolean" &&
        record.type !== "enum"
      ) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          `Child start param '${String(record.name)}' has an unsupported type`,
        );
      }
      return {
        name: record.name,
        type: record.type,
        ...(typeof record.required === "boolean"
          ? { required: record.required }
          : { required: false }),
        ...(Array.isArray(record.options) ? { options: record.options as string[] } : {}),
        ...(record.default !== undefined &&
        (typeof record.default === "string" ||
          typeof record.default === "number" ||
          typeof record.default === "boolean")
          ? { default: record.default as string | number | boolean }
          : {}),
      };
    }),
  };
}

/** Event-driven wake for one wait round. Cleans up both the bus subscription
 * and the abort listener on every path (no listener accumulation). */
function waitForWake(
  ctx: EngineContext,
  run: RunRecord,
  childRunId: string,
  active: ActiveRunState,
): Promise<void> {
  let cleanup = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    const off = ctx.store.bus.subscribe((envelope) => {
      if (active.abort.signal.aborted) {
        done();
        return;
      }
      // Child terminal/cancel/approval/progress wakes the parent wait.
      if ((envelope.runId as string) === childRunId) {
        if (
          envelope.type === "run.completed" ||
          envelope.type === "run.cancelled" ||
          envelope.type.startsWith("approval.") ||
          envelope.type.startsWith("node.")
        ) {
          done();
        }
        return;
      }
      // Parent-level park/cancel wakes the wait so the drive can yield.
      if ((envelope.runId as string) === (run.id as string)) {
        if (
          envelope.type === "run.paused" ||
          envelope.type === "run.cancelled" ||
          envelope.type === "run.completed"
        ) {
          done();
        }
      }
    });
    const onAbort = (): void => done();
    cleanup = (): void => {
      off();
      active.abort.signal.removeEventListener("abort", onAbort);
    };
    active.abort.signal.addEventListener("abort", onAbort);
    // Recheck after subscribing: the wake may have landed first.
    if (active.abort.signal.aborted) done();
  });
  return promise.finally(() => cleanup());
}

/**
 * Event-driven wait for child terminality. The waiter stays alive across
 * child approval/quota parks while the parent run is still running and only
 * yields (parked) when the parent itself parks or the drive aborts — the
 * invocation coroutine is never abandoned, so no polling loop is needed.
 */
async function waitForChild(
  ctx: EngineContext,
  run: RunRecord,
  childRunId: string,
  active: ActiveRunState,
): Promise<{ parked: true } | { parked: false; status: RunOutcome["status"]; result?: unknown }> {
  const childId = childRunId as RunId;
  for (;;) {
    const record = ctx.store.runs.get(childId);
    if (record) {
      const terminal = ["succeeded", "failed", "rejected", "cancelled"] as const;
      if ((terminal as readonly string[]).includes(record.status)) {
        return {
          parked: false,
          status: record.status as RunOutcome["status"],
          result: record.result ?? undefined,
        };
      }
    }
    checkStop(active);
    if (ctx.run(run.id).status !== "running") return { parked: true };
    await waitForWake(ctx, run, childRunId, active);
  }
}

export async function executeWorkflow(
  ctx: EngineContext,
  run: RunRecord,
  parentPlan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
  driver: WorkflowDriver,
): Promise<void> {
  checkStop(active);
  const path = node.id as Path;
  const raw = node.raw as Record<string, unknown>;
  const workflowId = raw.workflowId as string;
  const execution =
    ctx.store.executions.get(run.id, path) ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: String(raw.id),
      kind: "workflow",
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;
  let identity: ExecutionIdentity = {
    runId: run.id,
    path,
    attempt: execution.attempt,
    generation: execution.generation,
  };
  if (execution.status !== "running") {
    const resolvedConfigHash = await ctx.configHash(node);
    checkStop(active);
    identity = ctx.store.executions.beginInvocation({
      runId: run.id,
      path,
      attempt: execution.attempt,
      mode: "fresh",
      resolvedConfigHash,
    });
  }
  try {
    // Reattach: a linked child survives crashes; never spawn a duplicate.
    const link = ctx.store.workflowCalls.getLink(run.id, path, identity.attempt);
    let childRunId = link?.childRunId ?? null;
    let freshChild = false;
    if (!link) {
      const frozenBundle = ctx.store.workflowCalls.getBundle(run.id);
      if (!frozenBundle) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          "Run has no frozen workflow bundle; refusing to resolve a child at runtime",
        );
      }
      const snapshot = bundleSnapshotFor(frozenBundle.bundle, workflowId);
      // Depth + cycle guards (freeze walker enforces at launch; rechecked here for safety).
      const depth = parentDepth(ctx, run.id as string);
      if (depth + 1 > 8) {
        throw new DevChestraError("E_WORKFLOW_INVALID", "Workflow call depth exceeds 8");
      }
      const ancestors = ancestorWorkflowIds(ctx, run.id as string);
      if (ancestors.includes(workflowId)) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          `Workflow call cycle detected at '${workflowId}'`,
        );
      }
      // Evaluate bare JSONata inputs over parent scope (run params + ancestors).
      const ancestorsOut = await ctx.chainOutputs(run, parentPlan, node.id);
      const scope = buildScopeData(run.params, ancestorsOut);
      const inputsRaw = (raw.inputs ?? {}) as Record<string, unknown>;
      const evaluated: Record<string, unknown> = Object.create(null);
      for (const [key, expr] of Object.entries(inputsRaw)) {
        if (typeof expr !== "string") {
          throw new DevChestraError(
            "E_VALIDATION",
            `Workflow input '${key}' must be a string expression`,
          );
        }
        const compiled = compileExpression(expr);
        if (!compiled.ok) throw compiled.error;
        const result = await evaluate(compiled.value, scope, {
          executor: ctx.expressionExecutor(),
        });
        if (!result.ok) throw result.error;
        evaluated[key] = result.value as unknown;
      }
      // Validate against the child start params BEFORE spawning (defaults,
      // types, unknown keys). No child run exists when this fails.
      const validated = resolveParams(childStartParams(snapshot), evaluated);
      if (!validated.ok) {
        throw new DevChestraError("E_VALIDATION", "Workflow child parameters are invalid", {
          details: { issues: validated.errors },
        });
      }
      const binding = run.workspace;
      if (binding === null) {
        throw new DevChestraError(
          "E_WORKSPACE",
          "Workflow calls require a prepared parent workspace",
        );
      }
      // Inherit the prepared parent workspace explicitly: a new-worktree
      // parent maps to an existing-worktree binding at the parent's dir, so
      // the child reuses it instead of creating/cleaning a worktree.
      let childDir = binding.projectRoot;
      if (binding.selection.mode !== "project") {
        const prepare = ctx.deps.workspaces.prepare;
        if (!prepare) {
          throw new DevChestraError(
            "E_WORKSPACE",
            "Workspace port cannot resolve the parent directory",
          );
        }
        const resolved = await prepare({
          dataDir: ctx.deps.dataDir,
          projectId: run.project.id,
          runId: run.id as string,
          projectRoot: binding.projectRoot,
          selection: binding.selection,
          requireExisting: true,
          signal: active.abort.signal,
        });
        if (!resolved.ok) throw resolved.error;
        childDir = resolved.value.dir;
      }
      const childSelection =
        binding.selection.mode === "new-worktree"
          ? { mode: "existing-worktree" as const, path: childDir }
          : binding.selection.mode === "existing-worktree"
            ? { mode: "existing-worktree" as const, path: binding.selection.path }
            : binding.selection;
      const snapshotText = canonicalJson(snapshot);
      const childHash = await ctx.workflowHash(snapshot);
      // Atomic child create + bundle copy + link: one store transaction, so a
      // crash never leaves a duplicate or an unlinked orphan behind.
      const { assertLoopWorkspaceAvailable } = await import("./loop-workspace.js");
      const lineageRelated = (a: string, b: string): boolean => {
        const walkUp = (from: string, target: string): boolean => {
          let current: string | null = from;
          const seen = new Set<string>();
          while (current) {
            if (current === target) return true;
            if (seen.has(current)) return false;
            seen.add(current);
            const link = ctx.store.workflowCalls.getParent(current);
            current = link ? (link.parentRunId as string) : null;
          }
          return false;
        };
        return walkUp(a, b) || walkUp(b, a);
      };
      const created = ctx.store.tx(() => {
        const made = ctx.store.runs.create({
          projectId: run.project.id,
          workflowId,
          workflowHash: childHash,
          snapshot,
          snapshotRaw: snapshotText,
          params: validated.value as never,
          workspace: { selection: childSelection, projectRoot: binding.projectRoot },
        });
        if (made.duplicate) {
          throw new DevChestraError("E_INTERNAL", "Child run creation collided unexpectedly");
        }
        ctx.store.workflowCalls.putBundle(made.runId, frozenBundle.bundle, frozenBundle.hash);
        ctx.store.workflowCalls.link({
          identity,
          childRunId: made.runId as string,
          workflowId,
          workflowHash: childHash,
        });
        // Lineage links exist before the lock check so the parent/child
        // shared-workspace exemption applies; rollback covers all three.
        assertLoopWorkspaceAvailable(
          ctx.store.runs.get(made.runId) as RunRecord,
          ctx.store.runs.listActive(),
          lineageRelated,
        );
        return made;
      });
      childRunId = created.runId as string;
      freshChild = true;
    } else {
      checkStop(active);
    }
    if (!childRunId) throw new DevChestraError("E_INTERNAL", "Workflow child link is missing");
    // Ensure the child is driven (fresh prepare on first spawn, reuse-only on
    // reattach), then wait event-driven.
    const completion = driver.driveChild(childRunId, freshChild ? { fresh: true } : undefined);
    // Avoid unhandled rejection when we only observe via the bus.
    completion.catch(() => undefined);
    for (;;) {
      checkStop(active);
      const waited = await waitForChild(ctx, run, childRunId, active);
      if (waited.parked) return;
      const childRecord = ctx.store.runs.get(childRunId as RunId);
      if (!childRecord)
        throw new DevChestraError("E_NOT_FOUND", `Child run ${childRunId} disappeared`);
      const status = childRecord.status;
      if (!["succeeded", "failed", "rejected", "cancelled"].includes(status)) return;
      if (status === "cancelled") {
        // Cancelled children must not be swallowed as continue: record the
        // terminal link status (no ghost 'running' in the children API),
        // then stop/cancel the parent.
        try {
          ctx.store.workflowCalls.complete({
            identity,
            childRunId,
            status: "cancelled",
            resultRef: null,
          });
        } catch {
          // Already recorded or run inactive; never mask the stop.
        }
        throw new StopSignal("user");
      }
      const childStatus = status === "succeeded" ? "succeeded" : (status as "failed" | "rejected");
      // Without a `.failed` handler a failed/rejected child fails the invocation;
      // with one the controller succeeds and routing selects the `.failed` edge.
      const failedWired = (parentPlan.outgoing.get(node.id) ?? []).some(
        (edge) => edge.sourceBranch === "failed",
      );
      if (childStatus !== "succeeded" && !failedWired) {
        // Record the terminal child status durably before failing, so restart
        // reattaches instead of respawning.
        const envelope = { childRunId, status: childStatus, result: null };
        ctx.store.tx(() => {
          const recorded = ctx.store.outputs.recordDeterministic({ identity, output: envelope });
          ctx.store.workflowCalls.complete({
            identity,
            childRunId,
            status: childStatus,
            resultRef: recorded.output.id,
          });
        });
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          `Workflow call '${node.id}' child ${status}`,
          { details: { childRunId, workflowId } },
        );
      }
      // Validate optional output schema against the child's successful End result.
      const outputSchema = raw.output as Record<string, unknown> | undefined;
      if (outputSchema !== undefined && childStatus === "succeeded") {
        const validate = ctx.deps.validateOutput;
        if (!validate)
          throw new DevChestraError(
            "E_WORKFLOW_INVALID",
            "Workflow calls require an output validator",
          );
        const validation = validate(outputSchema, childRecord.result ?? null);
        if (!validation.ok) {
          throw new DevChestraError(
            "E_OUTPUT_INVALID",
            `Workflow '${node.id}' result does not match its schema`,
            {
              details: { issues: validation.issues },
            },
          );
        }
      }
      // Durable envelope: small refs in events, full result in the outputs table.
      // Single transaction so restart never sees a half-published success.
      const envelope = {
        childRunId,
        status: childStatus,
        result: childStatus === "succeeded" ? (childRecord.result ?? null) : null,
      };
      ctx.store.tx(() => {
        const recorded = ctx.store.outputs.recordDeterministic({ identity, output: envelope });
        ctx.store.workflowCalls.complete({
          identity,
          childRunId,
          status: childStatus,
          resultRef: recorded.output.id,
        });
        ctx.store.executions.complete({ identity });
      });
      return;
    }
  } catch (error) {
    if (error instanceof StopSignal) {
      const status = ctx.currentStatus(identity);
      if (status === "running") {
        // Parent cancel cascades to the active child; shutdown only interrupts.
        if (error.kind === "user") {
          const existing = ctx.store.workflowCalls.getLink(run.id, path, identity.attempt);
          if (existing) {
            try {
              await driver.cancelChild(existing.childRunId);
            } catch {
              // Cascade failures must not mask the parent stop.
            }
            // Record the terminal link status so the children API never shows
            // ghost running after the cascade lands.
            try {
              const child = ctx.store.runs.get(existing.childRunId as RunId);
              if (child?.status === "cancelled") {
                ctx.store.workflowCalls.complete({
                  identity,
                  childRunId: existing.childRunId,
                  status: "cancelled",
                  resultRef: null,
                });
              }
            } catch {
              // Already recorded or run inactive; never mask the stop.
            }
          }
        }
        ctx.transition(
          identity,
          error.kind === "shutdown" ? "interrupted" : "cancelled",
          error.kind,
        );
      }
      throw error;
    }
    ctx.failExecution(run, node, identity, toDevChestraError(error));
    throw error;
  }
}
