-- DevChestra P0 store schema. Forward-only; applied transactionally by src/migrate.ts.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'folder')),
  added_at INTEGER NOT NULL,
  next_run_number INTEGER NOT NULL DEFAULT 1,
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'node_test')),
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
  UNIQUE (project_id, run_number)
);
CREATE INDEX runs_by_project ON runs (project_id, created_at DESC);
CREATE INDEX runs_open ON runs (status) WHERE status IN ('queued', 'running', 'paused', 'waiting_approval');

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL
);
CREATE INDEX events_run ON events (run_id, id);
CREATE INDEX events_run_path ON events (run_id, path, id);
CREATE INDEX events_run_type ON events (run_id, type);

-- Projection of the shared @devchestra/core RunView. Rebuildable from events.
CREATE TABLE run_views (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  view_json TEXT NOT NULL,
  last_event_id INTEGER NOT NULL
);

CREATE TABLE executions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  cli TEXT,
  session_id TEXT,
  session_cwd TEXT,
  model TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  output_id TEXT,
  error_code TEXT,
  error_message TEXT,
  workspace_dir TEXT,
  branch TEXT,
  validation_attempts INTEGER NOT NULL DEFAULT 0,
  validation_limit INTEGER NOT NULL DEFAULT 3,
  crash_attempts INTEGER NOT NULL DEFAULT 0,
  last_event_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, path)
);
CREATE INDEX executions_status ON executions (run_id, status);

-- Process invocation fence. Each beginInvocation inserts one generation.
CREATE TABLE process_generations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  pid INTEGER,
  lstart TEXT,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  stop_reason TEXT,
  exit_code INTEGER,
  PRIMARY KEY (run_id, path, attempt, generation)
);

-- Immutable validated outputs and inputs/carry. Only kind='output' can be success.
CREATE TABLE outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('output', 'input', 'map_result', 'loop_carry')),
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX outputs_run_path ON outputs (run_id, path, attempt);
CREATE UNIQUE INDEX outputs_one_accepted ON outputs (run_id, path, attempt) WHERE kind = 'output';

-- Durable tool-call receipts. callId is X-DevChestra-Call-Id; request fingerprint is
-- the canonical JSON hash of {name, arguments}. A transport retry reuses the key.
CREATE TABLE tool_receipts (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  validation_attempt INTEGER,
  validation_attempts_after INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  output_id TEXT,
  event_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, path, attempt, generation, call_id)
);
CREATE INDEX tool_receipts_run ON tool_receipts (run_id, path, created_at);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
