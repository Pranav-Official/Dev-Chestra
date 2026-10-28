ALTER TABLE projects ADD COLUMN removed_at INTEGER;
ALTER TABLE runs ADD COLUMN archived_at INTEGER;
CREATE INDEX runs_workflow_visible ON runs(project_id, workflow_id, archived_at, created_at DESC, id DESC);
