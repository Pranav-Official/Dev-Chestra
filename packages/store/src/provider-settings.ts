import type { Runtime } from "./runtime.js";

export interface ProviderSettingRecord {
  cli: string;
  enabled: boolean;
  updatedAt: number;
}

interface ProviderSettingRow {
  cli: string;
  enabled: number;
  updated_at: number;
}

export function listProviderSettings(runtime: Runtime): ProviderSettingRecord[] {
  const rows = runtime.db
    .prepare("SELECT cli, enabled, updated_at FROM provider_settings ORDER BY cli ASC")
    .all() as ProviderSettingRow[];
  return rows.map((row) => ({
    cli: row.cli,
    enabled: row.enabled !== 0,
    updatedAt: row.updated_at,
  }));
}

export function setProviderEnabled(
  runtime: Runtime,
  cli: string,
  enabled: boolean,
  at: number,
): void {
  runtime.db
    .prepare(
      `INSERT INTO provider_settings (cli, enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cli) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .run(cli, enabled ? 1 : 0, at);
}

export function disabledClis(runtime: Runtime): ReadonlySet<string> {
  const rows = runtime.db.prepare("SELECT cli FROM provider_settings WHERE enabled = 0").all() as {
    cli: string;
  }[];
  return new Set(rows.map((row) => row.cli));
}
