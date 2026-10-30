-- Workflow calls + foreach: parent-child links, frozen bundles, foreach snapshots.
CREATE TABLE IF NOT EXISTS run_children (
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_path TEXT NOT NULL,
  parent_attempt INTEGER NOT NULL,
  parent_generation INTEGER NOT NULL,
  child_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','rejected','cancelled')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (parent_run_id, parent_path, parent_attempt),
  UNIQUE (child_run_id)
);
CREATE INDEX IF NOT EXISTS run_children_parent ON run_children (parent_run_id);
CREATE INDEX IF NOT EXISTS run_children_child ON run_children (child_run_id);

-- Frozen per-run workflow bundle: transitive NormalizedWorkflow snapshots.
CREATE TABLE IF NOT EXISTS run_bundles (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Immutable foreach source snapshots (never in events/projection).
CREATE TABLE IF NOT EXISTS foreach_sources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expression','csv')),
  source_hash TEXT NOT NULL,
  total INTEGER NOT NULL,
  max_items INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS foreach_sources_run ON foreach_sources (run_id, path);

-- Durable per-item records (no giant output array).
CREATE TABLE IF NOT EXISTS foreach_items (
  source_id TEXT NOT NULL REFERENCES foreach_sources(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','rejected','skipped')),
  result_json TEXT,
  output_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, idx)
);
