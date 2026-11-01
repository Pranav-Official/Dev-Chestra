-- Global per-provider on/off switch. A missing row means enabled.
CREATE TABLE provider_settings (
  cli TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
