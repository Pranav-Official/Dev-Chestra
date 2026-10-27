import type { EventEnvelope } from "@relay/core";
import { RelayError, relayErrorCode } from "../errors.js";
import { Connection, type ResolvedCursor } from "./connection.js";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_QUEUE_LIMIT,
  MAX_RUN_ID_LENGTH,
} from "./frames.js";
import { globalHints } from "./hints.js";
import type {
  StreamConnectionCounts,
  StreamEventPage,
  StreamHubOptions,
  StreamSnapshot,
  StreamStorePort,
} from "./types.js";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export class StreamHub {
  readonly #store: StreamStorePort;
  readonly #heartbeatMs: number;
  readonly #queueLimit: number;
  readonly #pageSize: number;
  readonly #runs = new Map<string, Set<Connection>>();
  readonly #global = new Set<Connection>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(options: StreamHubOptions) {
    this.#store = options.store;
    const heartbeat = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (!Number.isFinite(heartbeat) || heartbeat < 0) {
      throw new RelayError("E_INTERNAL", "heartbeatMs must be a non-negative number");
    }
    this.#heartbeatMs = heartbeat;
    this.#queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
    this.#pageSize = Math.min(Math.max(options.backlogPageSize ?? DEFAULT_PAGE_SIZE, 1), 500);
    this.#unsubscribe = this.#store.subscribe((event) => this.#onEvent(event));
  }

  get store(): StreamStorePort {
    return this.#store;
  }

  page(runId: string, options: { after: number; upTo: number; limit: number }): StreamEventPage {
    return this.#store.page(runId, options);
  }

  async handleRunStream(request: Request, rid: string): Promise<Response> {
    if (this.#closed) return relayJson("E_INTERNAL", "The server is shutting down");
    if (rid.length === 0 || rid.length > MAX_RUN_ID_LENGTH) {
      return relayJson("E_NOT_FOUND", "Run does not exist");
    }

    const cursor = resolveCursor(request);
    if (cursor === null) return relayJson("E_VALIDATION", "Invalid run cursor");

    const connection = new Connection(this, "run", rid, {
      queueLimit: this.#queueLimit,
      pageSize: this.#pageSize,
      heartbeatMs: this.#heartbeatMs,
    });
    this.#register(connection);

    let snapshot: StreamSnapshot | null;
    try {
      snapshot = this.#store.snapshot(rid);
    } catch (error) {
      connection.dispose();
      return mapStoreError(error);
    }
    if (snapshot === null) {
      connection.dispose();
      return relayJson("E_NOT_FOUND", "Run does not exist");
    }

    if (cursor.kind === "cursor") {
      const invalid = this.#validateCursor(rid, cursor.value, snapshot.watermark);
      if (invalid !== null) {
        connection.dispose();
        return invalid;
      }
    }

    return this.#response(request, connection, () => connection.startRun(snapshot, cursor));
  }

  handleGlobalStream(request: Request): Response {
    if (this.#closed) return relayJson("E_INTERNAL", "The server is shutting down");
    const connection = new Connection(this, "global", null, {
      queueLimit: this.#queueLimit,
      pageSize: this.#pageSize,
      heartbeatMs: this.#heartbeatMs,
    });
    this.#register(connection);
    return this.#response(request, connection, () => {
      connection.startGlobal();
      return Promise.resolve();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    const connections: Connection[] = [];
    for (const set of this.#runs.values()) connections.push(...set);
    connections.push(...this.#global);
    this.#runs.clear();
    this.#global.clear();
    for (const connection of connections) connection.shutdown();
  }

  counts(): StreamConnectionCounts {
    let runs = 0;
    for (const set of this.#runs.values()) runs += set.size;
    return { runs, global: this.#global.size };
  }

  runSubscriberCount(runId?: string): number {
    if (runId !== undefined) return this.#runs.get(runId)?.size ?? 0;
    let total = 0;
    for (const set of this.#runs.values()) total += set.size;
    return total;
  }

  globalSubscriberCount(): number {
    return this.#global.size;
  }

  #validateCursor(runId: string, cursor: number, watermark: number): Response | null {
    if (cursor > watermark) {
      return relayJson("E_VALIDATION", "Run cursor is ahead of the run watermark");
    }
    if (cursor === 0) return null;
    // Exact membership. `cursor - 1` may be another run's global event id, so
    // it is never used as a page anchor.
    if (!this.#store.hasEvent(runId, cursor)) {
      return relayJson("E_VALIDATION", "Run cursor is not valid for this run");
    }
    return null;
  }

  #response(request: Request, connection: Connection, start: () => Promise<void>): Response {
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          connection.attach(controller, request.signal);
          if (!connection.disposed) {
            void start().catch(() => {
              connection.overflow();
            });
          }
        },
        pull: () => connection.pull(),
        cancel: () => {
          connection.cancel();
        },
      },
      { highWaterMark: 1 },
    );
    return new Response(stream, { headers: SSE_HEADERS });
  }

  #register(connection: Connection): void {
    if (connection.kind === "global") {
      this.#global.add(connection);
      return;
    }
    const runId = connection.runId ?? "";
    let set = this.#runs.get(runId);
    if (set === undefined) {
      set = new Set<Connection>();
      this.#runs.set(runId, set);
    }
    set.add(connection);
  }

  unregister(connection: Connection): void {
    if (connection.kind === "global") {
      this.#global.delete(connection);
      return;
    }
    const runId = connection.runId ?? "";
    const set = this.#runs.get(runId);
    if (set === undefined) return;
    set.delete(connection);
    if (set.size === 0) this.#runs.delete(runId);
  }

  #onEvent(event: EventEnvelope): void {
    try {
      const runSet = this.#runs.get(event.runId);
      if (runSet !== undefined) {
        for (const connection of [...runSet]) connection.deliver(event);
      }
      if (this.#global.size > 0) {
        for (const hint of globalHints(event, this.#store)) {
          for (const connection of [...this.#global]) connection.deliverHint(hint);
        }
      }
    } catch {
      // The bus is an observer; a hub bug must never affect a commit.
    }
  }
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  return new StreamHub(options);
}

export function resolveCursor(request: Request): ResolvedCursor | null {
  const header = request.headers.get("last-event-id");
  const query = new URL(request.url).searchParams.get("after");

  let raw: string | null = null;
  if (header !== null && header.trim() !== "") {
    raw = header.trim();
  } else if (query !== null) {
    raw = query;
  }
  if (raw === null) return { kind: "none", value: 0 };
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return { kind: "cursor", value };
}

function relayJson(code: "E_VALIDATION" | "E_NOT_FOUND" | "E_INTERNAL", message: string): Response {
  const error = new RelayError(code, message);
  const body = { error: { code: error.code, message: error.message } };
  return new Response(JSON.stringify(body), {
    status: error.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function mapStoreError(error: unknown): Response {
  const code = relayErrorCode(error);
  if (code === "E_NOT_FOUND") return relayJson("E_NOT_FOUND", "Run does not exist");
  if (code === "E_VALIDATION" || code === "E_CONFLICT") {
    return relayJson("E_VALIDATION", "Invalid run cursor");
  }
  return relayJson("E_INTERNAL", "Stream unavailable");
}
