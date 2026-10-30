import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DevChestraError, type ExecutionIdentity, type Path } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import { FOREACH_MAX_ITEMS } from "@devchestra/store";
import type { Dispatch } from "./body-driver.js";
import { driveBodyPlan } from "./body-driver.js";
import type { ActiveRunState, EngineContext } from "./context.js";
import { toDevChestraError } from "./context.js";
import { parseCsv } from "./csv.js";
import { collectParentContext, resolveCaptureScope } from "./execution-context.js";
import { analyzeWorkflowPlan, type PlanNode, type WorkflowPlan } from "./graph-plan.js";
import { buildScopeData } from "./scope.js";
import { instantiateForeachBody } from "./scoped-plan.js";
import { StopSignal } from "./stop.js";

const SOURCE_FILE_CAP = 8 * 1024 * 1024;

function checkStop(active: ActiveRunState): void {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
}

async function workspaceDir(
  ctx: EngineContext,
  run: RunRecord,
  active: ActiveRunState,
): Promise<string> {
  const binding = run.workspace;
  if (binding === null) {
    throw new DevChestraError(
      "E_WORKSPACE",
      "Foreach csv sources require a prepared run workspace",
    );
  }
  if (binding.selection.mode === "project") return binding.projectRoot;
  const prepare = ctx.deps.workspaces.prepare;
  if (!prepare)
    throw new DevChestraError("E_WORKSPACE", "Workspace port cannot resolve the run directory");
  const result = await prepare({
    dataDir: ctx.deps.dataDir,
    projectId: run.project.id,
    runId: run.id as string,
    projectRoot: binding.projectRoot,
    selection: binding.selection,
    requireExisting: true,
    signal: active.abort.signal,
  });
  if (!result.ok) throw result.error;
  return result.value.dir;
}

/** Lexical + symlink-safe containment: realpath the root and the target, then compare. */
function containedFile(dir: string, rendered: string): string {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch (error) {
    throw new DevChestraError("E_WORKSPACE", "Run workspace is not available", { cause: error });
  }
  const candidate = resolve(root, rendered);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    throw new DevChestraError("E_NOT_FOUND", `Foreach csv file is missing: ${rendered}`, {
      cause: error,
    });
  }
  const outside = relative(root, real);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new DevChestraError("E_VALIDATION", "Foreach csv path escapes the workspace");
  }
  return real;
}

export async function executeForeach(
  ctx: EngineContext,
  run: RunRecord,
  parentPlan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
  dispatch: Dispatch,
): Promise<void> {
  checkStop(active);
  const path = node.id as Path;
  const raw = node.raw as Record<string, unknown> & {
    source: { kind: string; expression?: string; path?: string };
    maxItems?: number;
    onItemFailure?: string;
    result: string;
    output: Record<string, unknown>;
    body: { nodes: unknown[]; edges: unknown[] };
  };
  const execution =
    ctx.store.executions.get(run.id, path) ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: String(raw.id),
      kind: "foreach",
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
    const body = analyzeWorkflowPlan({ graph: raw.body });
    if (!body.ok) throw body.error;
    const maxItems = raw.maxItems === undefined ? FOREACH_MAX_ITEMS : (raw.maxItems as number);
    const onItemFailure = (raw.onItemFailure ?? "stop") as "stop" | "continue";
    const validate = ctx.deps.validateOutput;
    if (!validate)
      throw new DevChestraError("E_WORKFLOW_INVALID", "Foreach requires an output validator");

    // Resume path: the immutable snapshot for this attempt already exists.
    // Reuse its frozen items and parent capture; never re-evaluate live.
    const frozen = ctx.store.foreach.getSourceByAttempt(run.id, path, identity.attempt);
    let snapshot: NonNullable<ReturnType<typeof ctx.store.foreach.getSourceByAttempt>>;
    let parentScope: Record<string, unknown>;
    if (frozen) {
      snapshot = frozen;
      parentScope =
        frozen.parentCaptureId !== null
          ? resolveCaptureScope(ctx.store, run, frozen.parentCaptureId, ctx.contextCache)
          : collectParentContext(ctx, run, parentPlan, node.id).scope;
    } else {
      const parent = collectParentContext(ctx, run, parentPlan, node.id);
      let items: unknown[];
      let kind: "expression" | "csv";
      if (raw.source.kind === "csv") {
        kind = "csv";
        const template = String(raw.source.path ?? "");
        const rendered = await ctx.render(template, parent.scope);
        if (isAbsolute(rendered.text) || rendered.text.includes("\0")) {
          throw new DevChestraError(
            "E_VALIDATION",
            "Foreach csv path must be a relative workspace path",
          );
        }
        const dir = await workspaceDir(ctx, run, active);
        checkStop(active);
        const file = containedFile(dir, rendered.text);
        let text: string;
        try {
          const stat = statSync(file);
          if (!stat.isFile()) {
            throw new DevChestraError("E_VALIDATION", "Foreach csv path is not a regular file");
          }
          if (stat.size > SOURCE_FILE_CAP) {
            throw new DevChestraError("E_VALIDATION", "Foreach csv file exceeds the 8 MiB bound");
          }
          text = readFileSync(file, "utf8");
        } catch (error) {
          if (error instanceof DevChestraError) throw error;
          throw new DevChestraError(
            "E_NOT_FOUND",
            `Foreach csv file is missing: ${rendered.text}`,
            {
              cause: error,
            },
          );
        }
        if (Buffer.byteLength(text, "utf8") > SOURCE_FILE_CAP) {
          throw new DevChestraError("E_VALIDATION", "Foreach csv file exceeds the 8 MiB bound");
        }
        items = parseCsv(text);
      } else {
        kind = "expression";
        const value = await ctx.evaluate(String(raw.source.expression ?? ""), parent.scope);
        if (!Array.isArray(value)) {
          throw new DevChestraError(
            "E_VALIDATION",
            "Foreach expression source must evaluate to an array",
          );
        }
        items = value as unknown[];
      }
      if (items.length > maxItems) {
        throw new DevChestraError(
          "E_VALIDATION",
          `Foreach source has ${items.length} items exceeding maxItems ${maxItems}`,
        );
      }
      checkStop(active);
      // Freeze the parent capture once so resume resolves identical values.
      const capture = ctx.store.contextCaptures.create({
        runId: run.id,
        path,
        identity,
        entries: parent.entries,
      });
      const created = ctx.store.foreach.createSource({
        identity,
        kind,
        items,
        maxItems,
        parentCaptureId: capture.id,
      });
      snapshot = created.source;
      parentScope = parent.scope;
      ctx.store.foreach.start({
        identity,
        total: snapshot.total,
        maxItems,
        sourceId: snapshot.id,
        sourceHash: snapshot.sourceHash,
      });
    }
    // Ensure the started event exists (crash between source row and event).
    ctx.store.foreach.start({
      identity,
      total: snapshot.total,
      maxItems,
      sourceId: snapshot.id,
      sourceHash: snapshot.sourceHash,
    });
    // Durable resume index: never re-drive decided items, never re-decide.
    const decided = ctx.store.view.get(run.id).executions[path]?.foreach?.processed ?? 0;
    const recorded = ctx.store.foreach.listItems(snapshot.id).length;
    const startIndex = Math.min(decided, recorded, snapshot.total);
    for (let index = startIndex; index < snapshot.total; index += 1) {
      checkStop(active);
      const current = ctx.run(run.id);
      if (current.status === "paused" || current.status === "waiting_approval") return;
      if (current.status !== "running") return;
      const item = snapshot.items[index] as unknown;
      // Namespace is fixed BEFORE the body runs so workflow input mappings
      // inside the body observe the current row.
      const foreachNs = {
        item,
        index,
        number: index + 1,
        total: snapshot.total,
        parent: parentScope,
      };
      const itemPlan = instantiateForeachBody(body.value, node.id, index, { foreach: foreachNs });
      // Item-local failures (non-cancel) are recorded under continue policy;
      // cancellation and system aborts always propagate.
      let bodyDone: boolean;
      let bodyError: DevChestraError | null = null;
      try {
        bodyDone = await driveBodyPlan(ctx, run, itemPlan, active, dispatch);
      } catch (error) {
        if (error instanceof StopSignal) throw error;
        bodyError = toDevChestraError(error);
        bodyDone = false;
      }
      // Inspect the failed body execution so a rejected workflow child (or a
      // rejected end) records as rejected rather than always failed.
      const probeView = ctx.store.view.get(run.id);
      const probeFailed = itemPlan.nodes.find((candidate) => {
        const status = probeView.executions[candidate.id]?.status;
        return status === "failed" || status === "rejected" || status === "cancelled";
      });
      const probeStatus = probeFailed ? probeView.executions[probeFailed.id]?.status : undefined;
      const probeWorkflow = probeFailed
        ? probeView.executions[probeFailed.id]?.workflow
        : undefined;
      if (probeStatus === "cancelled") throw new StopSignal(active.reason ?? "user");
      const probeItemStatus =
        probeStatus === "rejected" || probeWorkflow?.status === "rejected"
          ? ("rejected" as const)
          : ("failed" as const);
      const probeMessage =
        probeFailed !== undefined
          ? (probeView.executions[probeFailed.id]?.lastError?.message ??
            `Foreach body '${probeFailed.id}' ${probeStatus}`)
          : (bodyError?.message ?? "Foreach body failed");
      if (!bodyDone) {
        if (bodyError && probeFailed !== undefined) {
          ctx.store.foreach.decideItem({
            identity,
            sourceId: snapshot.id,
            index,
            status: probeItemStatus,
            result: { error: probeMessage },
          });
          if (onItemFailure === "continue") continue;
        }
        if (bodyError) throw bodyError;
        return;
      }
      const view = ctx.store.view.get(run.id);
      const succeededEnds = itemPlan.ends.filter(
        (end) => view.executions[end.id]?.status === "succeeded",
      );
      const failedExec = itemPlan.nodes.find((candidate) => {
        const status = view.executions[candidate.id]?.status;
        return status === "failed" || status === "rejected" || status === "cancelled";
      });
      if (failedExec) {
        const status = view.executions[failedExec.id]?.status;
        if (status === "cancelled") throw new StopSignal(active.reason ?? "user");
        const err = view.executions[failedExec.id]?.lastError;
        if (onItemFailure === "continue") {
          ctx.store.foreach.decideItem({
            identity,
            sourceId: snapshot.id,
            index,
            status: status === "rejected" ? "rejected" : "failed",
            result: { error: err?.message ?? `Body node '${failedExec.id}' ${status}` },
          });
          continue;
        }
        throw new DevChestraError(
          err?.code ?? "E_INTERNAL",
          err?.message ?? `Foreach body '${failedExec.id}' ${status}`,
        );
      }
      if (succeededEnds.length !== 1) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          "Foreach body must complete exactly one End per item",
        );
      }
      const end = succeededEnds[0] as (typeof itemPlan.ends)[number];
      const endStatus = String((end.raw as Record<string, unknown>).status ?? "success");
      const itemStatus =
        endStatus === "failed" ? "failed" : endStatus === "rejected" ? "rejected" : "succeeded";
      const ancestors = await ctx.chainOutputs(run, itemPlan, end.id);
      const scope = buildScopeData({}, ancestors, { foreach: foreachNs });
      const mapped = await ctx.evaluate(String(raw.result), scope);
      const validation = validate(raw.output as Record<string, unknown>, mapped);
      if (!validation.ok) {
        const error = new DevChestraError(
          "E_OUTPUT_INVALID",
          `Foreach item ${index} does not match its schema`,
          { details: { issues: validation.issues, index } },
        );
        ctx.store.foreach.decideItem({
          identity,
          sourceId: snapshot.id,
          index,
          status: "failed",
          result: { error: error.message },
        });
        if (onItemFailure === "continue") continue;
        throw error;
      }
      if (itemStatus === "succeeded") {
        ctx.store.foreach.decideItem({
          identity,
          sourceId: snapshot.id,
          index,
          status: "succeeded",
          result: mapped,
        });
      } else if (onItemFailure === "continue") {
        ctx.store.foreach.decideItem({
          identity,
          sourceId: snapshot.id,
          index,
          status: itemStatus,
          result: mapped,
        });
      } else {
        throw new DevChestraError("E_OUTPUT_INVALID", `Foreach item ${index} ended ${itemStatus}`, {
          details: { index, status: itemStatus },
        });
      }
    }
    const view = ctx.store.view.get(run.id);
    const controller = view.executions[path]?.foreach;
    if (!controller) throw new DevChestraError("E_INTERNAL", "Foreach controller is missing");
    const output = {
      total: snapshot.total,
      processed: controller.processed,
      succeeded: controller.succeeded,
      failed: controller.failed,
      rejected: controller.rejected,
      resultsRef: snapshot.id,
    };
    // Single transaction for restart safety: output + success land together.
    ctx.store.tx(() => {
      ctx.store.outputs.recordDeterministic({ identity, output });
      ctx.store.executions.complete({ identity });
    });
  } catch (error) {
    if (error instanceof StopSignal) {
      const status = ctx.currentStatus(identity);
      if (status === "running") {
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
