import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { ApprovalSummary, RunLayout, RunWorkspaceSelection } from "@relay/api";
import type { Path, RunId, RunStatus } from "@relay/core";
import type { NormalizedWorkflow } from "@relay/schema";
import type {
  ExecutionHistory,
  ProjectRecord,
  RunRecord,
  RunSnapshot,
  Store,
  RunSummary as StoreRunSummary,
} from "@relay/store";
import type {
  BrowserQueryPort,
  EventPage,
  EventsQuery,
  ListRunsQuery,
  ProjectView,
  RegisterProjectCommand,
  RelinkProjectCommand,
  RunDetailView,
  RunListPage,
  RunSummary,
} from "./ports.js";

function workflowName(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const name = (snapshot as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function fromRunRecord(run: RunRecord): RunSummary {
  return {
    id: run.id,
    projectId: run.project.id,
    projectName: run.project.name,
    workflowId: run.workflowId,
    workflowName: workflowName(run.snapshot),
    runNumber: run.runNumber,
    kind: run.kind,
    status: run.status as RunStatus,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    pauseReason: run.pauseReason as RunSummary["pauseReason"],
    costUsd: run.costUsd,
    tokens: run.tokens,
    activeMs: run.activeMs,
  };
}

function fromStoreSummary(run: StoreRunSummary): RunSummary {
  return {
    id: run.id,
    projectId: run.projectId,
    projectName: run.projectName,
    workflowId: run.workflowId,
    workflowName: null,
    runNumber: run.runNumber,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    pauseReason: run.pauseReason as RunSummary["pauseReason"],
    costUsd: run.costUsd,
    tokens: run.tokens,
    activeMs: run.activeMs,
  };
}

const LAYOUT_BOUND = 10_000_000;

function layoutFromRaw(raw: string, snapshot: NormalizedWorkflow): RunLayout | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const graph = (parsed as { graph?: unknown }).graph;
  if (typeof graph !== "object" || graph === null) return undefined;
  const nodes = (graph as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  const known = new Set(snapshot.graph.nodes.map((node) => node.id));
  const entries: [string, { x: number; y: number }][] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as { id?: unknown; ui?: unknown };
    if (typeof record.id !== "string" || !known.has(record.id)) continue;
    const ui = record.ui;
    if (typeof ui !== "object" || ui === null) continue;
    const { x, y } = ui as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > LAYOUT_BOUND || Math.abs(y) > LAYOUT_BOUND) continue;
    entries.push([record.id, { x, y }]);
  }
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

/**
 * Frozen selection from the run record; legacy rows are null. Read
 * structurally so the server does not expose the internal projectRoot.
 */
function frozenWorkspace(run: RunRecord): RunWorkspaceSelection | null {
  const binding = (run as { workspace?: unknown }).workspace;
  if (typeof binding !== "object" || binding === null) return null;
  const selection = (binding as { selection?: unknown }).selection;
  return typeof selection === "object" && selection !== null
    ? (selection as RunWorkspaceSelection)
    : null;
}

function toProject(record: ProjectRecord): ProjectView {
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    kind: record.kind,
    missing: !existsSync(record.path),
    addedAt: record.addedAt,
  };
}

export function projectIdForPath(canonicalPath: string): string {
  return `p-${createHash("sha256").update(canonicalPath, "utf8").digest("hex").slice(0, 16)}`;
}

function approvalSummaryForRecord(
  store: Store,
  rec: import("@relay/store").ApprovalRecord,
): ApprovalSummary {
  const exec = store.executions.get(rec.runId, rec.path as Path);
  const nodeId = exec?.nodeId ?? rec.path;
  const page = store.events.page(rec.runId, { after: rec.requestedEventId - 1, limit: 1 });
  const ev = page.items[0];
  if (
    !ev ||
    ev.id !== rec.requestedEventId ||
    ev.type !== "approval.requested" ||
    ev.path !== rec.path
  )
    throw new Error(`Missing requested event ${rec.requestedEventId}`);
  const requestedAt = Date.parse(ev.ts);
  if (!Number.isFinite(requestedAt))
    throw new Error(`Invalid event ts for ${rec.requestedEventId}`);
  const execStatus = exec?.status as ApprovalSummary["status"] | undefined;
  const run = store.runs.get(rec.runId);
  if (!run) throw new Error(`Missing run ${rec.runId}`);
  let status: ApprovalSummary["status"];
  if (execStatus === "succeeded" || execStatus === "rejected" || execStatus === "cancelled")
    status = execStatus;
  else if (run.status === "cancelled") status = "cancelled";
  else status = "waiting_approval";
  return {
    runId: rec.runId,
    path: rec.path,
    nodeId,
    projectId: run.project.id,
    runNumber: run.runNumber,
    status,
    message: rec.message,
    criteria: rec.criteria,
    irreversible: rec.irreversible,
    requestedAt,
    attempt: rec.attempt,
    generation: rec.generation,
    requestId: rec.requestId,
    expectedAttempt: rec.attempt,
    expectedGeneration: rec.generation,
    requestEventId: rec.requestedEventId,
  };
}

export function createStoreQueryPort(store: Store): BrowserQueryPort {
  const getProject = (projectId: string): ProjectView | null => {
    const record = store.projects.get(projectId);
    return record === null ? null : toProject(record);
  };

  return {
    listProjects(): ProjectView[] {
      return store.projects.list().map(toProject);
    },
    getProject,
    registerProject(input: RegisterProjectCommand): ProjectView {
      const existing = store.projects.findByPath(input.path);
      if (existing !== null) return toProject(existing);
      const id = projectIdForPath(input.path);
      store.projects.ensure({
        id,
        name: input.name,
        path: input.path,
        kind: input.kind,
      });
      const record = store.projects.get(id);
      if (record === null) throw new Error("Registered project is not readable");
      return toProject(record);
    },
    relinkProject(input: RelinkProjectCommand): ProjectView {
      const record = store.projects.relink({
        projectId: input.projectId,
        path: input.path,
        name: input.name,
        kind: input.kind,
        missing: false,
      });
      return toProject(record);
    },
    listRuns(input: ListRunsQuery): RunListPage {
      const page = store.runs.list({
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: input.limit,
      });
      return { items: page.items.map(fromStoreSummary), nextCursor: page.nextCursor };
    },
    getRun(runId: string): RunSummary | null {
      const run = store.runs.get(runId as RunId);
      return run === null ? null : fromRunRecord(run);
    },
    runDetail(runId: string): RunDetailView | null {
      let snapshot: RunSnapshot;
      try {
        snapshot = store.view.snapshot(runId as RunId);
      } catch (error) {
        if ((error as { code?: unknown }).code === "E_NOT_FOUND") return null;
        throw error;
      }
      if (snapshot.run === null) return null;
      const normalized = snapshot.run.snapshot as NormalizedWorkflow;
      const layout = layoutFromRaw(snapshot.run.snapshotRaw, normalized);
      return {
        run: fromRunRecord(snapshot.run),
        view: snapshot.view,
        snapshot: normalized,
        watermark: snapshot.watermark,
        workspace: frozenWorkspace(snapshot.run),
        ...(layout === undefined ? {} : { layout }),
      };
    },
    eventsPage(runId: string, input: EventsQuery): EventPage {
      const page = store.events.page(runId as RunId, {
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.upTo === undefined ? {} : { upTo: input.upTo }),
        limit: input.limit,
        ...(input.types === undefined ? {} : { types: input.types }),
        ...(input.pathPrefix === undefined ? {} : { pathPrefix: input.pathPrefix }),
      });
      return {
        events: page.items,
        nextAfter: page.nextAfter ?? input.after ?? 0,
        hasMore: page.nextCursor !== null,
        watermark: page.watermark,
      };
    },
    getExecution(runId: string, path: string) {
      return store.executions.get(runId as RunId, path as Path);
    },
    executionHistory(runId: string, path: string): ExecutionHistory {
      return store.executions.history(runId as RunId, path as Path);
    },
    getOutput(runId: string, path: string, attempt: number) {
      return store.outputs.get({ runId: runId as RunId, path: path as Path, attempt });
    },
    counts() {
      let runs = 0;
      let cursor: string | undefined;
      for (;;) {
        const page = store.runs.list({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
        runs += page.items.length;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      const inbox = store.approvals.listPending().length;
      return {
        runs,
        activeRuns: store.runs.listActive().length,
        inbox,
      };
    },
    listApprovals(input: { projectId?: string; runId?: string; cursor?: string; limit: number }) {
      const limit = Math.min(Math.max(input.limit, 1), 500);
      const records = input.runId
        ? store.approvals.listPending({ runId: input.runId as RunId })
        : input.projectId
          ? store.approvals.listPending({ projectId: input.projectId })
          : store.approvals.listPending();
      const all = records.map((r) => approvalSummaryForRecord(store, r));
      all.sort((a, b) => a.requestedAt - b.requestedAt || a.requestEventId - b.requestEventId);
      const start = (() => {
        if (!input.cursor) return 0;
        const n = Number.parseInt(input.cursor, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      })();
      const items = all.slice(start, start + limit);
      const nextCursor = start + limit < all.length ? String(start + limit) : null;
      return { items, nextCursor };
    },
    getApproval(runId: string, path: string) {
      const exec = store.executions.get(runId as RunId, path as Path);
      if (!exec) return null;
      const rec = store.approvals.get({
        runId: runId as RunId,
        path: path as Path,
        attempt: exec.attempt,
        generation: exec.generation,
      });
      if (!rec) return null;
      // Legacy without stable requestId is read-only and omitted from inbox, but detail still truthful; do not fabricate
      if (!rec.requestId) return null;
      const summary = approvalSummaryForRecord(store, rec);
      const reqPage = store.events.page(runId as RunId, {
        after: rec.requestedEventId - 1,
        limit: 1,
      });
      const req = reqPage.items[0];
      if (
        !req ||
        req.id !== rec.requestedEventId ||
        req.type !== "approval.requested" ||
        req.path !== path
      )
        return { approval: summary, requestedEvent: null, resolvedEvent: null, execution: exec };
      let res: unknown = null;
      if (rec.resolvedEventId) {
        const resPage = store.events.page(runId as RunId, {
          after: rec.resolvedEventId - 1,
          limit: 1,
        });
        const r = resPage.items[0];
        if (r && r.id === rec.resolvedEventId && r.type === "approval.resolved" && r.path === path)
          res = r;
      }
      return { approval: summary, requestedEvent: req, resolvedEvent: res, execution: exec };
    },
  };
}
