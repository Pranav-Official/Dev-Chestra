import type { EventEnvelope, RunId, RunStatus } from "@devchestra/core";
import { ApiProtocolError } from "./errors.js";
import { eventEnvelopeSchema } from "./events.js";
import {
  epochMsSchema,
  eventIdSchema,
  projectIdSchema,
  runIdSchema,
  runStatusSchema,
  workflowIdSchema,
} from "./primitives.js";
import { runViewSchema } from "./view.js";
import { z } from "./zod.js";

const strict = z.strictObject;

export const runStreamQuerySchema = strict({
  after: z.coerce.number().int().nonnegative().optional(),
  upTo: z.coerce.number().int().nonnegative().optional(),
});

export type RunStreamQuery = z.infer<typeof runStreamQuerySchema>;

export interface RunStreamSnapshot {
  runId: RunId;
  view: import("@devchestra/core").RunView;
  watermark: number;
}

export const runStreamSnapshotSchema = strict({
  runId: runIdSchema,
  view: runViewSchema,
  watermark: z.number().int().nonnegative(),
}) as unknown as z.ZodType<RunStreamSnapshot>;

export interface RunStreamRunMessage {
  event: "run";
  /** Global SQLite event id; gaps between a run's ids are valid. */
  id: number;
  data: EventEnvelope;
}

export const runStreamRunMessageSchema = strict({
  event: z.literal("run"),
  id: eventIdSchema,
  data: eventEnvelopeSchema,
});

export interface RunStreamSnapshotMessage {
  event: "snapshot";
  data: RunStreamSnapshot;
}

export const runStreamSnapshotMessageSchema = strict({
  event: z.literal("snapshot"),
  data: runStreamSnapshotSchema,
});

export interface RunStreamOverflowMessage {
  event: "overflow";
  data: { lastEventId: number };
}

export const runStreamOverflowMessageSchema = strict({
  event: z.literal("overflow"),
  data: strict({ lastEventId: z.number().int().nonnegative() }),
});

export type RunStreamMessage =
  | RunStreamRunMessage
  | RunStreamSnapshotMessage
  | RunStreamOverflowMessage;

export const runStreamMessageSchema = z.discriminatedUnion("event", [
  runStreamRunMessageSchema,
  runStreamSnapshotMessageSchema,
  runStreamOverflowMessageSchema,
]) as unknown as z.ZodType<RunStreamMessage>;

export interface RunStatusHint {
  runId: RunId;
  projectId: string;
  workflowId: string;
  status: RunStatus;
  runNumber: number;
}

export const runStatusHintSchema = strict({
  runId: runIdSchema,
  projectId: projectIdSchema,
  workflowId: workflowIdSchema,
  status: runStatusSchema,
  runNumber: z.number().int().positive(),
}) as unknown as z.ZodType<RunStatusHint>;

export interface InboxHint {
  changed: true;
  counts?: {
    approvals: number;
    checkpoints: number;
    quota: number;
    recommendations: number;
    failed: number;
  };
}

export const inboxHintSchema = strict({
  changed: z.literal(true),
  counts: strict({
    approvals: z.number().int().nonnegative(),
    checkpoints: z.number().int().nonnegative(),
    quota: z.number().int().nonnegative(),
    recommendations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).optional(),
}) as unknown as z.ZodType<InboxHint>;

export interface ProviderHint {
  name: string;
  status: "ready" | "blocked" | "unknown";
  resumeAt?: number;
  reason?: string;
}

export const providerHintSchema = strict({
  name: z.string(),
  status: z.enum(["ready", "blocked", "unknown"]),
  resumeAt: epochMsSchema.optional(),
  reason: z.string().optional(),
}) as unknown as z.ZodType<ProviderHint>;

export interface NotificationHint {
  level: "info" | "warning" | "error";
  message: string;
  runId?: RunId;
}

export const notificationHintSchema = strict({
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  runId: runIdSchema.optional(),
}) as unknown as z.ZodType<NotificationHint>;

export interface ConfigHint {
  changed: true;
}

export const configHintSchema = strict({
  changed: z.literal(true),
}) as unknown as z.ZodType<ConfigHint>;

export type GlobalStreamMessage =
  | { event: "run.status"; data: RunStatusHint }
  | { event: "inbox"; data: InboxHint }
  | { event: "provider"; data: ProviderHint }
  | { event: "notification"; data: NotificationHint }
  | { event: "config"; data: ConfigHint };

export const globalStreamMessageSchema = z.discriminatedUnion("event", [
  strict({ event: z.literal("run.status"), data: runStatusHintSchema }),
  strict({ event: z.literal("inbox"), data: inboxHintSchema }),
  strict({ event: z.literal("provider"), data: providerHintSchema }),
  strict({ event: z.literal("notification"), data: notificationHintSchema }),
  strict({ event: z.literal("config"), data: configHintSchema }),
]) as unknown as z.ZodType<GlobalStreamMessage>;

/** One SSE frame after field parsing. `data` is the raw joined payload. */
export interface SseEvent {
  id: string | null;
  event: string | null;
  data: string;
  retry: number | null;
}

/**
 * Incremental SSE parser. Feed arbitrary text chunks; it emits complete frames
 * on blank-line boundaries and ignores comment lines (heartbeat).
 */
export class SseParser {
  #buffer = "";
  #event: string | null = null;
  #data: string[] = [];
  #id: string | null = null;
  #retry: number | null = null;

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const out: SseEvent[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line, out);
      newline = this.#buffer.indexOf("\n");
    }
    return out;
  }

  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.#buffer.length > 0) {
      let line = this.#buffer;
      this.#buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line, out);
    }
    this.#dispatch(out);
    return out;
  }

  #line(line: string, out: SseEvent[]): void {
    if (line === "") {
      this.#dispatch(out);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.#data.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      case "retry": {
        const retry = Number(value);
        if (Number.isSafeInteger(retry) && retry >= 0) this.#retry = retry;
        break;
      }
      default:
        break;
    }
  }

  #dispatch(out: SseEvent[]): void {
    if (this.#data.length > 0) {
      out.push({
        id: this.#id,
        event: this.#event,
        data: this.#data.join("\n"),
        retry: this.#retry,
      });
    }
    this.#reset();
  }

  #reset(): void {
    this.#event = null;
    this.#data = [];
    this.#id = null;
    this.#retry = null;
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Read a `text/event-stream` body into raw SSE frames. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted === true) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        for (const event of parser.push(text)) yield event;
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      for (const event of parser.push(tail)) yield event;
    }
    for (const event of parser.end()) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseJsonData(event: SseEvent, eventName: string): unknown {
  try {
    return JSON.parse(event.data);
  } catch (error) {
    throw new ApiProtocolError("event-stream", `Invalid JSON in '${eventName}' SSE data`, error);
  }
}

/** Parse one run-stream frame. Unknown event names are ignored for forward compatibility. */
export function parseRunStreamEvent(event: SseEvent): RunStreamMessage | null {
  const name = event.event;
  if (name !== "run" && name !== "snapshot" && name !== "overflow") return null;
  const data = parseJsonData(event, name);
  if (name === "run") {
    const id = event.id === null ? Number.NaN : Number(event.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new ApiProtocolError("event-stream", "'run' SSE frame requires a numeric id");
    }
    return parseWith(runStreamMessageSchema, { event: "run", id, data }, "run");
  }
  return parseWith(runStreamMessageSchema, { event: name, data }, name);
}

/** Parse one global-stream frame. Unknown event names are ignored. */
export function parseGlobalStreamEvent(event: SseEvent): GlobalStreamMessage | null {
  const name = event.event;
  if (
    name !== "run.status" &&
    name !== "inbox" &&
    name !== "provider" &&
    name !== "notification" &&
    name !== "config"
  ) {
    return null;
  }
  const data = parseJsonData(event, name);
  return parseWith(globalStreamMessageSchema, { event: name, data }, name);
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiProtocolError("event-stream", `Invalid '${name}' SSE message`, parsed.error);
  }
  return parsed.data;
}
