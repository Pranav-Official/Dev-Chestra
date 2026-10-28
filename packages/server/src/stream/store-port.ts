import type { EventEnvelope, RunId, RunView } from "@devchestra/core";
import type { RunRecord, Store } from "@devchestra/store";
import { devchestraErrorCode } from "../errors.js";
import type {
  StreamEventPage,
  StreamPageOptions,
  StreamSnapshot,
  StreamStorePort,
} from "./types.js";

type NativeSnapshot = {
  readonly runId?: string;
  readonly view: RunView;
  readonly watermark: number;
  readonly run?: RunRecord | null;
};

type NativePage = {
  readonly items: readonly EventEnvelope[];
  readonly nextCursor?: string | null;
  readonly watermark?: number;
};

type NativeStore = Store & {
  readonly view: Store["view"] & {
    snapshot?: (runId: string) => NativeSnapshot;
  };
  readonly events: Store["events"] & {
    page?: (runId: string, options: StreamPageOptions) => NativePage;
  };
};

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 500;
  if (!Number.isSafeInteger(limit)) return 500;
  return Math.min(Math.max(limit, 1), 500);
}

/**
 * Adapts today's Store API and automatically prefers the store-owner's
 * `view.snapshot()` / `events.page()` when those land. The fallback is still
 * atomic for snapshot+watermark: store reads and appends are synchronous on
 * one connection, so no write can interleave between the two calls.
 */
export function createStoreStreamPort(store: Store): StreamStorePort {
  const native = store as NativeStore;

  function snapshot(runId: string): StreamSnapshot | null {
    const nativeSnapshot = native.view.snapshot;
    try {
      if (typeof nativeSnapshot === "function") {
        const snap = nativeSnapshot.call(native.view, runId);
        const run = snap.run ?? store.runs.get(runId as RunId);
        return { runId, view: snap.view, watermark: snap.watermark, run };
      }
      const run = store.runs.get(runId as RunId);
      if (run === null) return null;
      const view = store.view.get(runId as RunId);
      return { runId, view, watermark: view.lastEventId, run };
    } catch (error) {
      if (devchestraErrorCode(error) === "E_NOT_FOUND") return null;
      throw error;
    }
  }

  function page(runId: string, options: StreamPageOptions = {}): StreamEventPage {
    const nativePage = native.events.page;
    if (typeof nativePage === "function") {
      const result = nativePage.call(native.events, runId, options);
      return {
        items: result.items,
        nextCursor: result.nextCursor ?? null,
        watermark: result.watermark ?? result.items.at(-1)?.id ?? options.after ?? 0,
      };
    }

    const limit = clampLimit(options.limit);
    const after = options.after ?? 0;
    const upTo = options.upTo;
    const rows = store.events.list(runId as RunId, { after, limit });
    const items = upTo === undefined ? rows : rows.filter((event) => event.id <= upTo);
    const last = items.at(-1);
    return {
      items,
      nextCursor: items.length >= limit && last !== undefined ? String(last.id) : null,
      watermark: last?.id ?? after,
    };
  }

  function hasEvent(runId: string, eventId: number): boolean {
    if (eventId <= 0 || !Number.isSafeInteger(eventId)) return false;
    // events.list does not validate its anchor; it returns the first event of
    // this run with id > eventId-1. Equality proves exact membership even when
    // eventId-1 belongs to another run.
    const rows = store.events.list(runId as RunId, { after: eventId - 1, limit: 1 });
    return rows[0]?.id === eventId;
  }

  return {
    snapshot,
    page,
    hasEvent,
    runHeader: (runId) => store.runs.get(runId as RunId),
    subscribe: (listener) => store.bus.subscribe(listener),
  };
}
