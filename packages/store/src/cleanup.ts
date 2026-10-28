import type { RunId } from "@devchestra/core";
import { now, type Runtime } from "./runtime.js";
import { fail } from "./util.js";

const TERMINAL = "'succeeded','failed','rejected','cancelled'";

export function removeProject(runtime: Runtime, projectId: string): void {
  if (!runtime.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) {
    fail("E_NOT_FOUND", "Project not found.");
  }
  if (
    runtime.db
      .prepare(`SELECT id FROM runs WHERE project_id = ? AND status NOT IN (${TERMINAL}) LIMIT 1`)
      .get(projectId)
  ) {
    fail(
      "E_CONFLICT",
      "Cannot remove this project while runs are active. Finish or cancel all active runs first (including paused runs and approvals).",
    );
  }
  runtime.db
    .prepare("UPDATE projects SET removed_at = COALESCE(removed_at, ?) WHERE id = ?")
    .run(now(runtime), projectId);
}

export function setRunArchived(runtime: Runtime, runId: RunId, archived: boolean): void {
  const run = runtime.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  if (!run) fail("E_NOT_FOUND", "Run not found.");
  if (archived && !["succeeded", "failed", "rejected", "cancelled"].includes(run.status)) {
    fail("E_CONFLICT", "Only completed runs can be archived. Active runs remain visible.");
  }
  runtime.db
    .prepare("UPDATE runs SET archived_at = ? WHERE id = ?")
    .run(archived ? now(runtime) : null, runId);
}

export function archiveWorkflowRuns(runtime: Runtime, projectId: string, workflowId: string): void {
  runtime.db
    .prepare(
      `UPDATE runs SET archived_at = ? WHERE project_id = ? AND workflow_id = ? AND archived_at IS NULL AND status IN (${TERMINAL})`,
    )
    .run(now(runtime), projectId, workflowId);
}
