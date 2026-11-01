-- A trigger now has one credential: the HMAC signing secret that GitHub-style
-- senders use. The bearer token hash is no longer stored.
ALTER TABLE workflow_triggers DROP COLUMN token_hash;
