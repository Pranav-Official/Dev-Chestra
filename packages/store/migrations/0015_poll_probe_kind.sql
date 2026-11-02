-- Poll probes run as ordinary runs of kind 'poll_probe' so listings can hide
-- them. SQLite cannot drop a CHECK constraint, so the table is rebuilt with
-- the widened kind set; all run-child tables reference runs(id) ON DELETE
-- CASCADE and follow the rename.
CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'node_test', 'poll_probe')),
  status TEXT NOT NULL,
  workflow_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_raw TEXT NOT NULL,
  params_json TEXT NOT NULL,
  budgets_json TEXT NOT NULL,
  base_sha TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  pause_reason TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  paused_ms INTEGER NOT NULL DEFAULT 0,
  supervisor_usd REAL NOT NULL DEFAULT 0,
  result_json TEXT,
  workspace_json TEXT,
  archived_at INTEGER,
  UNIQUE (project_id, run_number)
);
INSERT INTO runs_new SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_by_project ON runs (project_id, created_at DESC);
CREATE INDEX runs_open ON runs (status) WHERE status IN ('queued', 'running', 'paused', 'waiting_approval');
CREATE INDEX runs_workflow_visible ON runs(project_id, workflow_id, archived_at, created_at DESC, id DESC);
CREATE INDEX runs_status_created ON runs(status, created_at);
