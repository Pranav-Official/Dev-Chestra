-- Webhook triggers: one row per workflow. Arming is runtime state. The saved
-- workflow file only declares that its start node accepts webhooks, and tokens
-- or signing secrets never appear there.
CREATE TABLE workflow_triggers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  armed INTEGER NOT NULL DEFAULT 0 CHECK (armed IN (0,1)),
  token_hash TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  armed_revision TEXT,
  armed_snapshot_json TEXT,
  armed_snapshot_raw TEXT,
  armed_bundle_json TEXT,
  armed_at INTEGER,
  refresh_error TEXT,
  last_delivery_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, workflow_id)
);

-- Delivery claims make provider retries idempotent for seven days. The claim
-- and the run it created commit in one transaction.
CREATE TABLE webhook_deliveries (
  hook_id TEXT NOT NULL REFERENCES workflow_triggers(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hook_id, delivery_id)
);
CREATE INDEX webhook_deliveries_created ON webhook_deliveries(created_at);

-- Queue reads: queued runs in arrival order, and status counts for the depth limit.
CREATE INDEX runs_status_created ON runs(status, created_at);
