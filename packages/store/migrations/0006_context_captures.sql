-- Reference-backed execution-context captures (Part A).
-- One row per immutable loop-parent capture; the loop.started event holds only
-- the capture id, never the hydrated parent scope.

CREATE TABLE IF NOT EXISTS context_captures (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS context_captures_run ON context_captures (run_id, path);
