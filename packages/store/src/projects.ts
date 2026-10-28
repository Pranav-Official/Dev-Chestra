import { now, type Runtime } from "./runtime.js";
import type { EnsureProjectInput, ProjectRecord, RelinkProjectInput } from "./types.js";
import { fail } from "./util.js";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  kind: "git" | "folder";
  added_at: number;
  next_run_number: number;
  missing: number;
}

const PROJECT_SELECT = `SELECT id, name, path, kind, added_at, next_run_number, missing
  FROM projects`;

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    kind: row.kind,
    addedAt: row.added_at,
    nextRunNumber: row.next_run_number,
    missing: row.missing !== 0,
  };
}

function getProjectRow(runtime: Runtime, projectId: string): ProjectRow | null {
  const row = runtime.db.prepare(`${PROJECT_SELECT} WHERE id = ?`).get(projectId) as
    | ProjectRow
    | undefined;
  return row ?? null;
}

export function ensureProject(runtime: Runtime, input: EnsureProjectInput): void {
  runtime.db
    .prepare(
      `INSERT INTO projects (id, name, path, kind, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET removed_at = NULL`,
    )
    .run(input.id, input.name, input.path, input.kind, now(runtime));
}

export function listProjects(runtime: Runtime): ProjectRecord[] {
  const rows = runtime.db
    .prepare(`${PROJECT_SELECT} WHERE removed_at IS NULL ORDER BY added_at ASC, id ASC`)
    .all() as ProjectRow[];
  return rows.map(mapProject);
}

export function getProject(runtime: Runtime, projectId: string): ProjectRecord | null {
  const row = getProjectRow(runtime, projectId);
  return row === null ? null : mapProject(row);
}

export function findProjectByPath(runtime: Runtime, path: string): ProjectRecord | null {
  const row = runtime.db.prepare(`${PROJECT_SELECT} WHERE path = ?`).get(path) as
    | ProjectRow
    | undefined;
  return row === undefined ? null : mapProject(row);
}

/**
 * Safe metadata update for a moved project. Project id, added_at,
 * next_run_number and every run/execution/workspace provenance row are
 * preserved; only registration metadata moves. Filesystem validation
 * (realpath/existence/data-dir rules) belongs to the server.
 */
export function relinkProject(runtime: Runtime, input: RelinkProjectInput): ProjectRecord {
  if (typeof input.projectId !== "string" || input.projectId.length === 0) {
    fail("E_VALIDATION", "projectId must be a non-empty string");
  }
  if (typeof input.path !== "string" || input.path.length === 0 || input.path.length > 4096) {
    fail("E_VALIDATION", "path must be a non-empty string");
  }
  if (input.path.includes("\0")) fail("E_VALIDATION", "path must not contain NUL");
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.length > 200 || input.name.includes("\0")) {
      fail("E_VALIDATION", "name must be a string of at most 200 characters");
    }
  }
  if (input.kind !== undefined && input.kind !== "git" && input.kind !== "folder") {
    fail("E_VALIDATION", "kind must be 'git' or 'folder'");
  }
  if (input.missing !== undefined && typeof input.missing !== "boolean") {
    fail("E_VALIDATION", "missing must be a boolean");
  }

  const existing = getProjectRow(runtime, input.projectId);
  if (existing === null) fail("E_NOT_FOUND", `Project ${input.projectId} does not exist`);

  const collision = runtime.db
    .prepare("SELECT id FROM projects WHERE path = ? AND id <> ?")
    .get(input.path, input.projectId) as { id: string } | undefined;
  if (collision) {
    fail("E_CONFLICT", `Path is already registered to project ${collision.id}`, {
      path: input.path,
      otherProjectId: collision.id,
    });
  }

  // A relink means the server already validated the filesystem path, so the
  // default is healthy unless the caller explicitly says otherwise.
  const missing = input.missing ?? false;

  runtime.db
    .prepare(
      `UPDATE projects
          SET path = ?, name = COALESCE(?, name), kind = COALESCE(?, kind), missing = ?
        WHERE id = ?`,
    )
    .run(input.path, input.name ?? null, input.kind ?? null, missing ? 1 : 0, input.projectId);

  const updated = getProject(runtime, input.projectId);
  if (updated === null) fail("E_INTERNAL", "Relinked project disappeared");
  return updated;
}
