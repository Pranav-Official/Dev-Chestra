-- Execution context pool: mutable run-scoped blackboard.
-- Static project/workflow pools live frozen in the run snapshot; only the
-- execution pool is a live table. History is kept in events, not here.
CREATE TABLE context_entries (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (run_id, key)
);
CREATE INDEX context_entries_run ON context_entries (run_id, updated_at);
