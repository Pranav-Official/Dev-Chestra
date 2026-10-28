import type { Clock, EventEnvelope, IdGen } from "@devchestra/core";
import type { EventBus } from "./bus.js";
import type { SqliteDb } from "./driver.js";
import type { SecretRegistry } from "./secrets.js";

/** Shared state for the single synchronous writer and its transaction queue. */
export interface Runtime {
  readonly db: SqliteDb;
  readonly clock: Clock;
  readonly idGen: IdGen;
  readonly bus: EventBus;
  readonly secrets: SecretRegistry;
  depth: number;
  pending: EventEnvelope[];
  poisoned: boolean;
  poisonError: unknown;
}

export function now(runtime: Runtime): number {
  return runtime.clock.now();
}

/**
 * Run a synchronous read inside one SQLite read transaction. Nested calls from
 * an existing write transaction join it instead of starting a second one.
 */
export function withReadTx<T>(runtime: Runtime, fn: () => T): T {
  if (runtime.depth > 0) return fn();
  runtime.db.exec("BEGIN DEFERRED");
  try {
    const result = fn();
    runtime.db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      runtime.db.exec("ROLLBACK");
    } catch {
      // Keep the original failure.
    }
    throw error;
  }
}
