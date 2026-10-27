import type { Path } from "@relay/core";
import { RelayError } from "@relay/core";
import type { RunRecord } from "@relay/store";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode, WorkflowPlan } from "./graph-plan.js";
import { buildScopeData } from "./scope.js";
import { StopSignal } from "./stop.js";

function readMessage(raw: Readonly<Record<string, unknown>>): string {
  const value = raw.message;
  if (typeof value !== "string")
    throw new RelayError("E_WORKFLOW_INVALID", "Approval message is missing");
  if (value.trim() === "" || value.length > 4096)
    throw new RelayError("E_WORKFLOW_INVALID", "Approval message must be 1-4096 chars");
  return value;
}

function readIrreversible(raw: Readonly<Record<string, unknown>>): boolean {
  const value = raw.irreversible;
  if (typeof value !== "boolean")
    throw new RelayError("E_WORKFLOW_INVALID", "Approval irreversible flag is missing");
  return value;
}

function readCriteria(raw: Readonly<Record<string, unknown>>): string[] | undefined {
  const value = raw.criteria;
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new RelayError("E_WORKFLOW_INVALID", "Approval criteria must be an array");
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string")
      throw new RelayError("E_WORKFLOW_INVALID", "Approval criteria entries must be strings");
    out.push(entry);
  }
  return out.length === 0 ? undefined : out;
}

export async function executeApproval(
  ctx: EngineContext,
  run: RunRecord,
  plan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  if (node.type !== "approval")
    throw new RelayError("E_INTERNAL", `executeApproval called for ${node.type}`);

  const path = node.id as Path;
  const existing = ctx.store.executions.get(run.id, path);
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: node.id,
      kind: "approval",
      requireSubmission: false,
    });

  if (
    execution.status === "succeeded" ||
    execution.status === "rejected" ||
    execution.status === "cancelled" ||
    execution.status === "skipped"
  )
    return;
  if (execution.status === "waiting_approval") return;

  const configHash = await ctx.configHash(node);
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");

  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path,
    attempt: execution.attempt,
    mode: "fresh",
    resolvedConfigHash: configHash,
  });

  try {
    const ancestors = await ctx.chainOutputs(run, plan, node.id);
    const scope = buildScopeData(run.params, ancestors);
    const rawMessage = readMessage(node.raw);
    const rendered = await ctx.render(rawMessage, scope, false);
    const message = rendered.text;
    if (typeof message !== "string" || message.trim() === "" || message.length > 4096)
      throw new RelayError("E_VALIDATION", "Rendered approval message must be 1-4096 chars");
    const irreversible = readIrreversible(node.raw);
    const criteria = readCriteria(node.raw);

    if (active.abort.signal.aborted) {
      const kind = active.reason ?? "user";
      const status = ctx.currentStatus(identity);
      if (status === "running" || status === "validating")
        ctx.transition(identity, kind === "shutdown" ? "interrupted" : "cancelled", kind);
      throw new StopSignal(kind);
    }

    ctx.store.approvals.request({
      identity,
      message,
      irreversible,
      ...(criteria === undefined ? {} : { criteria }),
    });
  } catch (error) {
    if (error instanceof StopSignal) throw error;
    const relay = toRelayError(error);
    try {
      ctx.failExecution(run, node, identity, relay);
    } catch (e) {
      if (!(e instanceof RelayError) || e.code !== "E_CONFLICT") throw e;
    }
    throw relay;
  }
}
