import { type ClientRequest, request as httpRequest } from "node:http";

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

export interface SseOptions {
  baseUrl: string;
  path: string;
  cookie: string;
  origin?: string;
  lastEventId?: string;
  onFrame?: (frame: SseFrame) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export class SseConnection {
  readonly frames: SseFrame[] = [];
  readonly opened: Promise<void>;
  readonly ended: Promise<void>;
  error: Error | null = null;
  private readonly request: ClientRequest;
  private closed = false;
  private readonly onFrame: ((frame: SseFrame) => void) | undefined;

  constructor(options: SseOptions) {
    const url = new URL(options.path, options.baseUrl);
    this.onFrame = options.onFrame;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Cookie: options.cookie,
      "Cache-Control": "no-cache",
    };
    if (options.origin !== undefined) headers.Origin = options.origin;
    if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;

    let resolveOpened: () => void = () => undefined;
    let rejectOpened: (error: Error) => void = () => undefined;
    this.opened = new Promise<void>((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    let resolveEnded: () => void = () => undefined;
    this.ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });

    let buffer = "";
    let id: string | null = null;
    let event = "message";
    let data: string[] = [];
    let opened = false;

    const dispatch = (): void => {
      if (data.length === 0) {
        id = null;
        event = "message";
        return;
      }
      const frame: SseFrame = { id, event, data: data.join("\n") };
      this.frames.push(frame);
      this.onFrame?.(frame);
      id = null;
      event = "message";
      data = [];
    };

    const consume = (text: string): void => {
      buffer += text;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          dispatch();
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    };

    this.request = httpRequest(
      url,
      {
        method: "GET",
        headers,
        timeout: 0,
      },
      (res) => {
        if (res.statusCode !== 200) {
          rejectOpened(new Error(`SSE returned ${String(res.statusCode)}`));
          res.resume();
          resolveEnded();
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => consume(chunk));
        res.on("end", () => {
          opened = true;
          resolveOpened();
          resolveEnded();
        });
        res.on("error", (error) => {
          this.error = error;
          if (!opened) rejectOpened(error);
          resolveEnded();
        });
        opened = true;
        resolveOpened();
      },
    );
    this.request.on("error", (error) => {
      this.error = error;
      rejectOpened(error);
      resolveEnded();
    });
    this.request.end();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.request.destroy();
  }

  runFrames(): Array<{ id: number; frame: SseFrame }> {
    const output: Array<{ id: number; frame: SseFrame }> = [];
    for (const frame of this.frames) {
      if (frame.event !== "run") continue;
      if (frame.id === null || !/^\d+$/.test(frame.id)) continue;
      output.push({ id: Number(frame.id), frame });
    }
    return output;
  }

  async waitFor(
    predicate: (frames: readonly SseFrame[]) => boolean,
    timeoutMs = 20_000,
    label = "SSE condition",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(this.frames)) return;
      if (this.error !== null) throw this.error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label}; frames=${String(this.frames.length)}`);
      }
      await sleep(20);
    }
  }
}

export function parseFrameData(frame: SseFrame): Record<string, unknown> {
  const parsed: unknown = JSON.parse(frame.data);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`SSE ${frame.event} data is not an object`);
  }
  return parsed as Record<string, unknown>;
}
