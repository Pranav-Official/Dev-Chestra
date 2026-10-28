import type { EventEnvelope } from "@devchestra/core";
import type { GlobalStreamHint, StreamSnapshot } from "./types.js";

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_QUEUE_LIMIT = 5_000;
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_RUN_ID_LENGTH = 200;
export const HEARTBEAT_FRAME = ": heartbeat\n\n";

const ENCODER = new TextEncoder();

export function runFrame(event: EventEnvelope): string {
  return `id: ${event.id}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`;
}

export function snapshotFrame(snapshot: StreamSnapshot): string {
  return `event: snapshot\ndata: ${JSON.stringify({
    runId: snapshot.runId,
    view: snapshot.view,
    watermark: snapshot.watermark,
  })}\n\n`;
}

export function overflowFrame(lastEventId: number): string {
  return `event: overflow\ndata: ${JSON.stringify({ lastEventId })}\n\n`;
}

export function hintFrame(hint: GlobalStreamHint): string {
  return `event: ${hint.event}\ndata: ${JSON.stringify(hint.data)}\n\n`;
}

/**
 * Bounded outbound queue over a real ReadableStream. `highWaterMark` is 1 and
 * pull() waits for the next frame, so the socket controls consumption instead
 * of an unbounded in-memory array.
 */
export class FrameWriter {
  readonly #limit: number;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #queue: Uint8Array[] = [];
  #closed = false;
  #closeAfterDrain = false;
  #pullWaiter: (() => void) | null = null;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
    this.#pump();
  }

  push(frame: string): boolean {
    if (this.#closed) return false;
    if (this.#queue.length >= this.#limit) return false;
    this.#queue.push(ENCODER.encode(frame));
    this.#pump();
    return true;
  }

  /** Heartbeats never overflow a busy connection; skip while data is queued. */
  heartbeat(frame: string): void {
    if (this.#closed || this.#queue.length > 0) return;
    this.#queue.push(ENCODER.encode(frame));
    this.#pump();
  }

  overflow(frame: string): void {
    if (this.#closed) return;
    this.#queue = [ENCODER.encode(frame)];
    this.#closeAfterDrain = true;
    this.#pump();
  }

  pull(): Promise<void> | void {
    const enqueued = this.#pump();
    if (this.#closed || enqueued || this.#queue.length > 0) return;
    return new Promise<void>((resolve) => {
      this.#pullWaiter = resolve;
    });
  }

  close(): void {
    this.#queue = [];
    this.#closed = true;
    this.#resolvePull();
    try {
      this.#controller?.close();
    } catch {
      // Already cancelled by the peer.
    }
  }

  cancel(): void {
    this.#queue = [];
    this.#closed = true;
    this.#resolvePull();
    try {
      this.#controller?.close();
    } catch {
      // Already cancelled by the peer.
    }
  }

  #resolvePull(): void {
    const waiter = this.#pullWaiter;
    this.#pullWaiter = null;
    waiter?.();
  }

  #pump(): boolean {
    const controller = this.#controller;
    if (controller === null || this.#closed) return false;

    let enqueued = false;
    while (
      controller.desiredSize !== null &&
      controller.desiredSize > 0 &&
      this.#queue.length > 0
    ) {
      const frame = this.#queue.shift();
      if (frame === undefined) break;
      try {
        controller.enqueue(frame);
      } catch {
        this.#queue = [];
        this.#closed = true;
        this.#resolvePull();
        return enqueued;
      }
      enqueued = true;
    }

    if (enqueued) this.#resolvePull();

    if (this.#closeAfterDrain && this.#queue.length === 0) {
      this.#closed = true;
      try {
        controller.close();
      } catch {
        // Already cancelled by the peer.
      }
      this.#resolvePull();
      return true;
    }
    return enqueued;
  }
}
