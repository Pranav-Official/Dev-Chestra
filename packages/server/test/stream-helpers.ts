import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, FakeIdGen, type Path, type RunId } from "@devchestra/core";
import { openStore, type Store } from "@devchestra/store";
import { Hono } from "hono";
import { type RunningLoopbackServer, startLoopbackServer } from "../src/node.js";
import {
  createStoreStreamPort,
  createStreamHub,
  mountStreamRoutes,
  type StreamHub,
  type StreamStorePort,
} from "../src/stream/index.js";

export interface SseFrame {
  readonly event: string;
  readonly id: string | null;
  readonly data: string | null;
  readonly heartbeat: boolean;
  readonly raw: string;
}

export interface Harness {
  readonly dir: string;
  readonly store: Store;
  readonly hub: StreamHub;
  readonly server: RunningLoopbackServer;
  readonly runId: RunId;
  readonly close: () => Promise<void>;
}

export interface HarnessOptions {
  readonly heartbeatMs?: number;
  readonly queueLimit?: number;
  readonly port?: (store: Store) => StreamStorePort;
}

const cleanups: (() => Promise<void>)[] = [];

export async function openHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "devchestra-stream-test-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(Date.UTC(2026, 0, 1)),
    idGen: new FakeIdGen("stream"),
  });
  store.projects.ensure({ id: "project-1", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "project-1",
    workflowId: "workflow-1",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: "{}",
  });

  const port = options.port?.(store) ?? createStoreStreamPort(store);
  const hub = createStreamHub({
    store: port,
    heartbeatMs: options.heartbeatMs ?? 0,
    ...(options.queueLimit === undefined ? {} : { queueLimit: options.queueLimit }),
  });
  const app = new Hono();
  mountStreamRoutes(app, hub);
  const server = await startLoopbackServer(app, { port: 0, hostname: "127.0.0.1" });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    hub.close();
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  };
  cleanups.push(close);

  return { dir, store, hub, server, runId: run.runId, close };
}

export async function closeAll(): Promise<void> {
  for (const close of cleanups.splice(0).reverse()) await close();
}

export function appendMany(
  store: Store,
  runId: RunId,
  count: number,
  options: { prefix?: string; value?: string } = {},
): void {
  const prefix = options.prefix ?? "event";
  let written = 0;
  while (written < count) {
    const batch = Math.min(100, count - written);
    const drafts = Array.from({ length: batch }, (_, index) => ({
      runId,
      path: "" as Path,
      type: "run.override.added" as const,
      actor: "user" as const,
      payload: {
        nodeId: "node-1",
        kind: "param" as const,
        value: `${options.value ?? prefix}-${written + index}`,
        reason: "stream test",
      },
    }));
    store.events.append(runId, drafts);
    written += batch;
  }
}

export function largeEvents(store: Store, runId: RunId, count: number, bytes = 60_000): void {
  const value = "x".repeat(bytes);
  for (let index = 0; index < count; index += 1) {
    store.events.append(runId, [
      {
        runId,
        path: "" as Path,
        type: "run.override.added",
        actor: "user",
        payload: { nodeId: "node-1", kind: "param", value, reason: `large-${index}` },
      },
    ]);
  }
}

export class SseClient {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async next(timeoutMs = 10_000): Promise<SseFrame | null> {
    while (true) {
      const separator = this.#buffer.indexOf("\n\n");
      if (separator >= 0) {
        const raw = this.#buffer.slice(0, separator);
        this.#buffer = this.#buffer.slice(separator + 2);
        return parseFrame(raw);
      }
      if (this.#done) return null;
      const read = await withTimeout(this.#reader.read(), timeoutMs, "SSE read timed out");
      if (read.done) {
        this.#done = true;
        if (this.#buffer.trim() === "") return null;
        const raw = this.#buffer;
        this.#buffer = "";
        return parseFrame(raw);
      }
      this.#buffer += this.#decoder.decode(read.value, { stream: true });
    }
  }

  async nextMeaningful(timeoutMs = 10_000): Promise<SseFrame> {
    while (true) {
      const frame = await this.next(timeoutMs);
      if (frame === null) throw new Error("SSE stream ended before a meaningful frame");
      if (!frame.heartbeat) return frame;
    }
  }

  async collect(limit: number, timeoutMs = 20_000): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    while (frames.length < limit) {
      const frame = await this.nextMeaningful(timeoutMs);
      frames.push(frame);
    }
    return frames;
  }

  async cancel(): Promise<void> {
    try {
      await this.#reader.cancel();
    } catch {
      // Already closed.
    }
  }
}

export interface OpenSse {
  readonly response: Response;
  readonly client: SseClient;
  readonly abort: AbortController;
}

export async function openSse(
  harness: Harness,
  path: string,
  headers: Record<string, string> = {},
): Promise<OpenSse> {
  const abort = new AbortController();
  const response = await fetch(`${harness.server.url}${path}`, { headers, signal: abort.signal });
  if (response.body === null) throw new Error("SSE response has no body");
  return { response, client: new SseClient(response.body.getReader()), abort };
}

export async function closeSse(sse: OpenSse): Promise<void> {
  await sse.client.cancel();
  sse.abort.abort();
}

function parseFrame(raw: string): SseFrame {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  let commentOnly = true;

  for (const line of raw.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(":")) continue;
    commentOnly = false;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }

  return {
    event,
    id,
    data: data.length === 0 ? null : data.join("\n"),
    heartbeat: commentOnly && event === "message" && id === null && data.length === 0,
    raw,
  };
}

export function parseData<T>(frame: SseFrame): T {
  if (frame.data === null) throw new Error(`SSE frame ${frame.event} has no data`);
  return JSON.parse(frame.data) as T;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
