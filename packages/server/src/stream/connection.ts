import type { EventEnvelope } from "@relay/core";
import {
  FrameWriter,
  HEARTBEAT_FRAME,
  hintFrame,
  overflowFrame,
  runFrame,
  snapshotFrame,
} from "./frames.js";
import type { GlobalStreamHint, StreamEventPage, StreamSnapshot } from "./types.js";

export interface ResolvedCursor {
  readonly kind: "none" | "cursor";
  readonly value: number;
}

/** The slice of StreamHub a connection needs; avoids an import cycle. */
export interface ConnectionHub {
  page(runId: string, options: { after: number; upTo: number; limit: number }): StreamEventPage;
  unregister(connection: Connection): void;
}

export class Connection {
  readonly writer: FrameWriter;
  readonly kind: "run" | "global";
  readonly runId: string | null;
  readonly #hub: ConnectionHub;
  readonly #pageSize: number;
  readonly #liveLimit: number;
  readonly #heartbeatMs: number;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #abortCleanup: (() => void) | null = null;
  #disposed = false;
  #liveMode = false;
  #live: EventEnvelope[] = [];
  #lastSent = 0;

  constructor(
    hub: ConnectionHub,
    kind: "run" | "global",
    runId: string | null,
    options: { queueLimit: number; pageSize: number; heartbeatMs: number },
  ) {
    this.#hub = hub;
    this.kind = kind;
    this.runId = runId;
    this.#pageSize = options.pageSize;
    this.#liveLimit = Math.max(1, options.queueLimit);
    this.#heartbeatMs = options.heartbeatMs;
    this.writer = new FrameWriter(options.queueLimit);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get lastSent(): number {
    return this.#lastSent;
  }

  attach(controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal): void {
    this.writer.attach(controller);
    const onAbort = (): void => {
      this.cancel();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    this.#abortCleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
  }

  startHeartbeat(): void {
    if (this.#heartbeatMs <= 0 || this.#disposed) return;
    this.#heartbeat = setInterval(() => {
      this.writer.heartbeat(HEARTBEAT_FRAME);
    }, this.#heartbeatMs);
    this.#heartbeat.unref?.();
  }

  async startRun(snapshot: StreamSnapshot, cursor: ResolvedCursor): Promise<void> {
    this.startHeartbeat();
    if (cursor.kind === "cursor") {
      await this.replay(cursor.value, snapshot.watermark);
      if (this.#disposed) return;
      this.markLive();
      return;
    }

    this.#lastSent = Math.max(this.#lastSent, snapshot.watermark);
    if (!this.writer.push(snapshotFrame(snapshot))) {
      this.overflow();
      return;
    }
    this.markLive();
  }

  startGlobal(): void {
    this.startHeartbeat();
    this.markLive();
  }

  deliver(event: EventEnvelope): void {
    if (this.#disposed || this.kind !== "run" || event.runId !== this.runId) return;
    if (this.#liveMode) {
      this.sendEvent(event);
      return;
    }
    if (this.#live.length >= this.#liveLimit) {
      this.overflow();
      return;
    }
    this.#live.push(event);
  }

  deliverHint(hint: GlobalStreamHint): void {
    if (this.#disposed || this.kind !== "global") return;
    if (!this.writer.push(hintFrame(hint))) this.overflow();
  }

  pull(): Promise<void> | void {
    return this.writer.pull();
  }

  cancel(): void {
    if (this.#disposed) return;
    this.dispose();
    this.writer.cancel();
  }

  shutdown(): void {
    if (this.#disposed) {
      this.writer.close();
      return;
    }
    this.dispose();
    this.writer.close();
  }

  overflow(): void {
    if (this.#disposed) {
      this.writer.overflow(overflowFrame(this.#lastSent));
      return;
    }
    this.dispose();
    this.writer.overflow(overflowFrame(this.#lastSent));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.#abortCleanup?.();
    this.#abortCleanup = null;
    this.#live = [];
    this.#hub.unregister(this);
  }

  private markLive(): void {
    if (this.#disposed) return;
    this.#liveMode = true;
    const pending = this.#live;
    this.#live = [];
    pending.sort((left, right) => left.id - right.id);
    for (const event of pending) {
      if (this.#disposed) return;
      if (event.id <= this.#lastSent) continue;
      if (!this.sendEvent(event)) return;
    }
  }

  private sendEvent(event: EventEnvelope): boolean {
    if (this.#disposed || event.runId !== this.runId) return true;
    if (event.id <= this.#lastSent) return true;
    if (!this.writer.push(runFrame(event))) {
      this.overflow();
      return false;
    }
    this.#lastSent = event.id;
    return true;
  }

  private async replay(from: number, upTo: number): Promise<void> {
    let after = from;
    while (!this.#disposed && after < upTo) {
      let page: StreamEventPage;
      try {
        page = this.#hub.page(this.runId ?? "", { after, upTo, limit: this.#pageSize });
      } catch {
        this.overflow();
        return;
      }
      const items = page.items;
      if (items.length === 0) return;

      let progressed = false;
      for (const event of items) {
        if (this.#disposed) return;
        if (event.id > upTo) return;
        if (event.runId !== this.runId) continue;
        if (event.id <= this.#lastSent) {
          after = Math.max(after, event.id);
          continue;
        }
        if (!this.sendEvent(event)) return;
        after = event.id;
        progressed = true;
      }
      if (!progressed || items.length < this.#pageSize) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#disposed) return;
    }
  }
}
