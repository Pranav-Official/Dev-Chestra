-- Polling triggers: one row per workflow. Arming (and the interval) is
-- runtime state. The saved workflow file only declares support
-- (`start.polling.enabled` plus the probe); the probe and interval never live
-- there. The scheduler ticks armed pollers whose next_due_at has passed.
CREATE TABLE workflow_pollers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  armed INTEGER NOT NULL DEFAULT 0 CHECK (armed IN (0,1)),
  interval_seconds INTEGER,
  armed_revision TEXT,
  armed_snapshot_json TEXT,
  armed_snapshot_raw TEXT,
  armed_bundle_json TEXT,
  armed_at INTEGER,
  next_due_at INTEGER,
  last_tick_at INTEGER,
  last_outcome TEXT,
  last_run_id TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  refresh_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, workflow_id)
);

-- Poll dedupe claims make repeated probe results idempotent for seven days.
-- The key is the probe's dedupeKey, or the params hash when it returned none.
-- The claim and the run it created commit in one transaction.
CREATE TABLE poll_dedupe_claims (
  poller_id TEXT NOT NULL REFERENCES workflow_pollers(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poller_id, dedupe_key)
);
CREATE INDEX poll_dedupe_claims_created ON poll_dedupe_claims(created_at);

-- Scheduler reads: armed pollers whose next probe is due, earliest first.
CREATE INDEX workflow_pollers_due ON workflow_pollers(armed, next_due_at);
