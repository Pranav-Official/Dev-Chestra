-- Foreach parent capture ref: reuse the immutable ancestor capture on resume.
ALTER TABLE foreach_sources ADD COLUMN parent_capture_id TEXT;
