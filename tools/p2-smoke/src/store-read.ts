import { createRequire } from "node:module";
import { join } from "node:path";
import type { EventEnvelope, RunId, RunView } from "@relay/core";

interface NodeStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}

type NodeDatabaseCtor = new (file: string, options?: { readOnly?: boolean }) => NodeDatabase;

const require = createRequire(import.meta.url);

export interface StoreSnapshot {
  events: EventEnvelope[];
  view: RunView | null;
}

function openReadOnly(file: string): NodeDatabase {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: NodeDatabaseCtor };
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

interface EventRow {
  id: number;
  run_id: string;
  ts: number;
  path: string;
  type: string;
  actor: string;
  v: number;
  payload: string;
}

/** Read the real SQLite log without running the store's migrations or writers. */
export function readStoreSnapshot(dataDir: string, runId: string): StoreSnapshot {
  const db = openReadOnly(join(dataDir, "relay.db"));
  try {
    const rows = db
      .prepare(
        `SELECT id, run_id, ts, path, type, actor, v, payload
         FROM events WHERE run_id = ? ORDER BY id ASC`,
      )
      .all(runId) as EventRow[];
    const events = rows.map(
      (row): EventEnvelope =>
        ({
          id: row.id,
          runId: row.run_id as RunId,
          ts: new Date(row.ts).toISOString(),
          path: row.path,
          type: row.type,
          actor: row.actor,
          v: row.v,
          payload: JSON.parse(row.payload) as unknown,
        }) as EventEnvelope,
    );
    const viewRow = db.prepare("SELECT view_json FROM run_views WHERE run_id = ?").get(runId) as
      | { view_json: string }
      | undefined;
    return {
      events,
      view: viewRow === undefined ? null : (JSON.parse(viewRow.view_json) as RunView),
    };
  } finally {
    db.close();
  }
}
