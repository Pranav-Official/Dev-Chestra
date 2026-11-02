-- Persist the identity of the actual OS process after spawn.
-- Additive only; existing databases upgrade in place.
ALTER TABLE process_generations ADD COLUMN pid_start TEXT;
ALTER TABLE process_generations ADD COLUMN binary TEXT;
ALTER TABLE process_generations ADD COLUMN cwd TEXT;

-- Materialize the node kind so read ports do not need event/JSON parsing.
ALTER TABLE executions ADD COLUMN kind TEXT;

-- Explicit, audited user approval to retry an interrupted shell whose side
-- effects are uncertain. Never written automatically.
CREATE TABLE uncertain_retries (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, path, attempt, generation)
);
