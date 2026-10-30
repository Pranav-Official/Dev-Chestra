import type { ExecutionIdentity, Path, RunId } from "@devchestra/core";
import { assertRunActive } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import { fail, parseJson } from "./util.js";

export interface LinkChildInput {
  identity: ExecutionIdentity;
  childRunId: string;
  workflowId: string;
  workflowHash: string;
}

export interface ChildLink {
  parentRunId: RunId;
  parentPath: Path;
  parentAttempt: number;
  parentGeneration: number;
  childRunId: string;
  workflowId: string;
  workflowHash: string;
  status: "running" | "succeeded" | "failed" | "rejected" | "cancelled";
}

/** Atomic parent->child link. PK(parent_run,path,attempt) prevents duplicate spawn across crashes. */
export function linkChild(
  runtime: Runtime,
  input: LinkChildInput,
): { link: ChildLink; duplicate: boolean } {
  assertRunActive(runtime, input.identity.runId);
  const existing = runtime.db
    .prepare(
      "SELECT parent_run_id, parent_path, parent_attempt, parent_generation, child_run_id, workflow_id, workflow_hash, status FROM run_children WHERE parent_run_id = ? AND parent_path = ? AND parent_attempt = ?",
    )
    .get(input.identity.runId, input.identity.path, input.identity.attempt) as
    | {
        parent_run_id: string;
        parent_path: string;
        parent_attempt: number;
        parent_generation: number;
        child_run_id: string;
        workflow_id: string;
        workflow_hash: string;
        status: ChildLink["status"];
      }
    | undefined;
  if (existing) {
    if (existing.child_run_id !== input.childRunId || existing.workflow_id !== input.workflowId) {
      fail("E_CONFLICT", "Workflow node already linked to a different child run", {
        existing: existing.child_run_id,
        received: input.childRunId,
      });
    }
    return { link: mapLink(existing), duplicate: true };
  }
  // Child row must exist (genuine engine run, same process or earlier).
  const child = runtime.db.prepare("SELECT id FROM runs WHERE id = ?").get(input.childRunId);
  if (!child) fail("E_NOT_FOUND", `Child run ${input.childRunId} does not exist`);
  // Same-project enforcement is durable: compare project ids.
  const parent = runtime.db
    .prepare("SELECT project_id FROM runs WHERE id = ?")
    .get(input.identity.runId as string) as { project_id: string } | undefined;
  const childProj = runtime.db
    .prepare("SELECT project_id FROM runs WHERE id = ?")
    .get(input.childRunId) as { project_id: string } | undefined;
  if (parent && childProj && parent.project_id !== childProj.project_id) {
    fail("E_VALIDATION", "Workflow child must belong to the same project", {
      parent: parent.project_id,
      child: childProj.project_id,
    });
  }
  try {
    runtime.db
      .prepare(
        `INSERT INTO run_children
           (parent_run_id, parent_path, parent_attempt, parent_generation, child_run_id, workflow_id, workflow_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        input.identity.runId,
        input.identity.path,
        input.identity.attempt,
        input.identity.generation,
        input.childRunId,
        input.workflowId,
        input.workflowHash,
        now(runtime),
      );
  } catch (error) {
    // Lost race inside the same transaction boundary: re-read the winner.
    const winner = runtime.db
      .prepare(
        "SELECT parent_run_id, parent_path, parent_attempt, parent_generation, child_run_id, workflow_id, workflow_hash, status FROM run_children WHERE parent_run_id = ? AND parent_path = ? AND parent_attempt = ?",
      )
      .get(input.identity.runId, input.identity.path, input.identity.attempt) as
      | {
          parent_run_id: string;
          parent_path: string;
          parent_attempt: number;
          parent_generation: number;
          child_run_id: string;
          workflow_id: string;
          workflow_hash: string;
          status: ChildLink["status"];
        }
      | undefined;
    if (winner) {
      if (winner.child_run_id !== input.childRunId || winner.workflow_id !== input.workflowId) {
        fail("E_CONFLICT", "Workflow node already linked to a different child run", {
          cause: error,
        });
      }
      return { link: mapLink(winner), duplicate: true };
    }
    throw error;
  }
  return {
    link: {
      parentRunId: input.identity.runId,
      parentPath: input.identity.path,
      parentAttempt: input.identity.attempt,
      parentGeneration: input.identity.generation,
      childRunId: input.childRunId,
      workflowId: input.workflowId,
      workflowHash: input.workflowHash,
      status: "running",
    },
    duplicate: false,
  };
}

function mapLink(row: {
  parent_run_id: string;
  parent_path: string;
  parent_attempt: number;
  parent_generation: number;
  child_run_id: string;
  workflow_id: string;
  workflow_hash: string;
  status: ChildLink["status"];
}): ChildLink {
  return {
    parentRunId: row.parent_run_id as RunId,
    parentPath: row.parent_path as Path,
    parentAttempt: row.parent_attempt,
    parentGeneration: row.parent_generation,
    childRunId: row.child_run_id,
    workflowId: row.workflow_id,
    workflowHash: row.workflow_hash,
    status: row.status,
  };
}

export function getChildLink(
  runtime: Runtime,
  parentRunId: RunId,
  parentPath: Path,
  parentAttempt: number,
): ChildLink | null {
  const row = runtime.db
    .prepare(
      "SELECT parent_run_id, parent_path, parent_attempt, parent_generation, child_run_id, workflow_id, workflow_hash, status FROM run_children WHERE parent_run_id = ? AND parent_path = ? AND parent_attempt = ?",
    )
    .get(parentRunId, parentPath, parentAttempt) as
    | {
        parent_run_id: string;
        parent_path: string;
        parent_attempt: number;
        parent_generation: number;
        child_run_id: string;
        workflow_id: string;
        workflow_hash: string;
        status: ChildLink["status"];
      }
    | undefined;
  return row ? mapLink(row) : null;
}

export function getParentLink(runtime: Runtime, childRunId: string): ChildLink | null {
  const row = runtime.db
    .prepare(
      "SELECT parent_run_id, parent_path, parent_attempt, parent_generation, child_run_id, workflow_id, workflow_hash, status FROM run_children WHERE child_run_id = ?",
    )
    .get(childRunId) as
    | {
        parent_run_id: string;
        parent_path: string;
        parent_attempt: number;
        parent_generation: number;
        child_run_id: string;
        workflow_id: string;
        workflow_hash: string;
        status: ChildLink["status"];
      }
    | undefined;
  return row ? mapLink(row) : null;
}

export function listChildLinks(runtime: Runtime, parentRunId: RunId): ChildLink[] {
  const rows = runtime.db
    .prepare(
      "SELECT parent_run_id, parent_path, parent_attempt, parent_generation, child_run_id, workflow_id, workflow_hash, status FROM run_children WHERE parent_run_id = ? ORDER BY created_at ASC",
    )
    .all(parentRunId) as {
    parent_run_id: string;
    parent_path: string;
    parent_attempt: number;
    parent_generation: number;
    child_run_id: string;
    workflow_id: string;
    workflow_hash: string;
    status: ChildLink["status"];
  }[];
  return rows.map(mapLink);
}

export function setChildStatus(
  runtime: Runtime,
  parentRunId: RunId,
  parentPath: Path,
  parentAttempt: number,
  status: ChildLink["status"],
): void {
  runtime.db
    .prepare(
      "UPDATE run_children SET status = ? WHERE parent_run_id = ? AND parent_path = ? AND parent_attempt = ?",
    )
    .run(status, parentRunId, parentPath, parentAttempt);
}

export interface RunBundle {
  runId: RunId;
  hash: string;
  bundle: Record<string, unknown>;
}

export function putRunBundle(
  runtime: Runtime,
  runId: RunId,
  bundle: Record<string, unknown>,
  hash: string,
): void {
  runtime.db
    .prepare(
      `INSERT INTO run_bundles (run_id, hash, json, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET hash = excluded.hash, json = excluded.json`,
    )
    .run(runId, hash, JSON.stringify(bundle), now(runtime));
}

export function getRunBundle(runtime: Runtime, runId: RunId): RunBundle | null {
  const row = runtime.db
    .prepare("SELECT hash, json FROM run_bundles WHERE run_id = ?")
    .get(runId) as { hash: string; json: string } | undefined;
  if (!row) return null;
  return { runId, hash: row.hash, bundle: parseJson<Record<string, unknown>>(row.json) };
}
