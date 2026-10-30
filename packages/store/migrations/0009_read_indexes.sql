-- TD-008 opportunistic read-model indexes (index-only; no ETag/locking change).
-- events has no created_at column (it stores ts epoch-ms); cover ts ordering for
-- run-scoped replays. outputs feed orders by (created_at DESC, id DESC) in
-- read-ports.ts listOutputs* queries. executions.output_id -> outputs(id) FK is
-- deliberately omitted: SQLite cannot ADD CONSTRAINT without a table rebuild,
-- and deletes already cascade via run_id; index the lookup instead.
CREATE INDEX IF NOT EXISTS events_run_ts ON events (run_id, ts, id);
CREATE INDEX IF NOT EXISTS outputs_run_created ON outputs (run_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS executions_output ON executions (output_id) WHERE output_id IS NOT NULL;
