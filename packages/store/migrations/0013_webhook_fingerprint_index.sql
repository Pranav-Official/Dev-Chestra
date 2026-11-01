-- Replays are matched by body fingerprint within the retention window, whatever
-- delivery ID the request carried, so the lookup needs its own index.
CREATE INDEX webhook_deliveries_fingerprint ON webhook_deliveries(hook_id, fingerprint);
