export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(statement: string): unknown;
  close(): void;
}

export interface SqliteOpenOptions {
  readonly?: boolean;
}

/** The only seam through which @relay/store touches a SQLite implementation. */
export interface SqliteDriver {
  open(file: string, options?: SqliteOpenOptions): SqliteDb;
}
