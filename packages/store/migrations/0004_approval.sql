-- Durable human approval checkpoints (no auto/supervisor/timeouts)
CREATE TABLE approvals (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  message TEXT NOT NULL,
  irreversible INTEGER NOT NULL CHECK (irreversible IN (0,1)),
  criteria_json TEXT,
  requested_event_id INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('approve','reject')),
  decided_by TEXT,
  note TEXT,
  resolved_event_id INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (run_id, path, attempt, generation)
);
CREATE INDEX approvals_run ON approvals (run_id, path);
CREATE INDEX approvals_request ON approvals (request_id);
-- Durable wake marker for crash after resolution before scheduler wake
CREATE TABLE approval_wakes (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (run_id, path, attempt, generation)
);
CREATE INDEX approval_wakes_run ON approval_wakes (run_id) WHERE consumed_at IS NULL;
