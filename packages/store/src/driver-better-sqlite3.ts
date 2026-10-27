import Database from "better-sqlite3";
import type { SqliteDb, SqliteDriver, SqliteRunResult, SqliteStatement } from "./driver.js";

function wrapStatement(stmt: {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}): SqliteStatement {
  return {
    run(...params: unknown[]): SqliteRunResult {
      const result = stmt.run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get(...params: unknown[]): unknown {
      return stmt.get(...params);
    },
    all(...params: unknown[]): unknown[] {
      return stmt.all(...params);
    },
  };
}

/** Default driver; the caller installs better-sqlite3 (native, synchronous). */
export const betterSqliteDriver: SqliteDriver = {
  open(file: string, options?: { readonly?: boolean }): SqliteDb {
    const db = new Database(file, { readonly: options?.readonly ?? false });
    return {
      exec(sql: string): void {
        db.exec(sql);
      },
      prepare(sql: string): SqliteStatement {
        return wrapStatement(db.prepare(sql));
      },
      pragma(statement: string): unknown {
        return db.pragma(statement);
      },
      close(): void {
        db.close();
      },
    };
  },
};
