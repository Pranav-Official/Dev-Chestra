-- Freeze the run-level workspace choice. NULL means a pre-workspace run
-- whose behavior stays on the legacy per-node workspace mode.
ALTER TABLE runs ADD COLUMN workspace_json TEXT;
