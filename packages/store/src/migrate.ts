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
  { version: 9, file: "0009_read_indexes.sql" },
  { version: 10, file: "0010_provider_settings.sql" },
  { version: 11, file: "0011_webhooks_and_queue.sql" },
  { version: 12, file: "0012_drop_bearer_token.sql" },
  { version: 13, file: "0013_webhook_fingerprint_index.sql" },
  { version: 14, file: "0014_poll_triggers.sql" },
  { version: 15, file: "0015_poll_probe_kind.sql" },
];

/**
 * Migrations that rebuild a parent table. SQLite's DROP TABLE performs an
 * implicit DELETE that follows ON DELETE CASCADE, so the rebuild must run
 * with foreign keys off (a no-op inside a transaction, hence outside it) and
 * is verified with foreign_key_check afterwards.
 */
const FK_OFF_MIGRATIONS: ReadonlySet<string> = new Set(["0015_poll_probe_kind.sql"]);

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
    const fkOff = FK_OFF_MIGRATIONS.has(migration.file);
    if (fkOff) db.exec("PRAGMA foreign_keys = OFF");
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
      if (fkOff) db.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    if (fkOff) {
      db.exec("PRAGMA foreign_keys = ON");
      const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Migration ${migration.file} left ${violations.length} foreign key violation(s); refusing to open. Restore a backup.`,
        );
      }
    }
  }

  return readUserVersion(db);
}
