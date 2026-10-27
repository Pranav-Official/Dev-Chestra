import type { EventEnvelope, RunView } from "@relay/core";
import type { RunRecord } from "@relay/store";

/**
 * One atomic run read: `view` includes exactly the committed events whose ids
 * are <= `watermark`. `watermark` is a run event id, not a global sequence
 * length, so it may be followed by a gap before the next event of this run.
 */
export interface StreamSnapshot {
  readonly runId: string;
  readonly view: RunView;
  readonly watermark: number;
  readonly run: RunRecord | null;
}

export interface StreamPageOptions {
  readonly after?: number;
  readonly upTo?: number;
  readonly limit?: number;
}

export interface StreamEventPage {
  readonly items: readonly EventEnvelope[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

/**
 * Narrow store port owned by the server/stream composition. The store remains
 * the only SQLite writer; the hub never polls after the initial snapshot/page
 * reads and never writes.
 */
export interface StreamStorePort {
  /** Null when the run does not exist. Must be one synchronous/atomic read. */
  snapshot(runId: string): StreamSnapshot | null;
  /** Ordered by event id ascending; `upTo` is inclusive. */
  page(runId: string, options?: StreamPageOptions): StreamEventPage;
  /** Exact membership. Must not assume id-1 is a valid page anchor. */
  hasEvent(runId: string, eventId: number): boolean;
  /** Run header used only for low-volume global invalidation hints. */
  runHeader(runId: string): RunRecord | null;
  /** Exactly one hub subscription; the store publishes after commit. */
  subscribe(listener: (event: EventEnvelope) => void): () => void;
}

export type GlobalStreamEventName = "run.status" | "inbox" | "provider" | "notification" | "config";

/** Invalidation hint only. Never authoritative reducer input, never an envelope. */
export type GlobalStreamHint =
  | {
      readonly event: "run.status";
      readonly data: {
        readonly runId: string;
        readonly projectId: string;
        readonly workflowId: string;
        readonly status: string;
        readonly runNumber: number;
      };
    }
  | { readonly event: "inbox"; readonly data: { readonly changed: true } }
  | {
      readonly event: "provider";
      readonly data: {
        readonly name: string;
        readonly status: string;
        readonly resumeAt?: number;
        readonly reason?: string;
      };
    }
  | {
      readonly event: "notification";
      readonly data: { readonly level: string; readonly message: string; readonly runId?: string };
    }
  | { readonly event: "config"; readonly data: { readonly changed: true } };

export interface StreamHubOptions {
  readonly store: StreamStorePort;
  /** Default 15_000; 0 disables (tests). */
  readonly heartbeatMs?: number;
  /** Default 5_000 frames waiting for the socket. */
  readonly queueLimit?: number;
  /** Default 500, clamped to 1..500. */
  readonly backlogPageSize?: number;
}

export interface StreamConnectionCounts {
  readonly runs: number;
  readonly global: number;
}
