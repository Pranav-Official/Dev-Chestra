import { createRequire } from "node:module";
import type { SqliteDb, SqliteDriver, SqliteStatement } from "./driver.js";

interface NodeStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}

type NodeDatabaseCtor = new (file: string, options?: { readOnly?: boolean }) => NodeDatabase;

/**
 * Explicit fallback for environments without a better-sqlite3 prebuild.
 * Selected only by passing this driver (or DEVCHESTRA_SQLITE=node at a caller layer);
 * it never triggers a native source compilation.
 */
export const nodeSqliteDriver: SqliteDriver = {
  open(file: string, options?: { readonly?: boolean }): SqliteDb {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: NodeDatabaseCtor };
    const db = new DatabaseSync(file, { readOnly: options?.readonly ?? false });
    return {
      exec(sql: string): void {
        db.exec(sql);
      },
      prepare(sql: string): SqliteStatement {
        const stmt = db.prepare(sql);
        return {
          run(...params: unknown[]) {
            const result = stmt.run(...params);
            return {
              changes: Number(result.changes),
              lastInsertRowid: Number(result.lastInsertRowid),
            };
          },
          get(...params: unknown[]): unknown {
            return stmt.get(...params);
          },
          all(...params: unknown[]): unknown[] {
            return stmt.all(...params);
          },
        };
      },
      pragma(statement: string): unknown {
        return db.prepare(`PRAGMA ${statement}`).all();
      },
      close(): void {
        db.close();
      },
    };
  },
};
