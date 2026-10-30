import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqliteDb } from "./driver.js";

interface Migration {
  version: number;
  file: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, file: "0001_init.sql" },
  { version: 2, file: "0002_process_identity.sql" },
  { version: 3, file: "0003_run_workspace.sql" },
  { version: 4, file: "0004_approval.sql" },
  { version: 5, file: "0005_workspace_cleanup.sql" },
  { version: 6, file: "0006_context_captures.sql" },
  { version: 7, file: "0007_workflow_foreach.sql" },
  { version: 8, file: "0008_foreach_parent.sql" },
];

function migrationsDir(): string {
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

function readUserVersion(db: SqliteDb): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Forward-only, one transaction per migration. Refuses databases newer than
 * this build instead of guessing. Returns the resulting version.
 */
export function applyMigrations(db: SqliteDb, now: number): number {
  const current = readUserVersion(db);
  const newest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (current > newest) {
    throw new Error(
      `DevChestra database schema version ${current} is newer than this build (${newest}); refusing to open. Restore a backup.`,
    );
  }

  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const sql = readFileSync(`${migrationsDir()}${migration.file}`, "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        now,
      );
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return readUserVersion(db);
}
