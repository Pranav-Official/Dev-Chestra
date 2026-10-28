import { spawn } from "node:child_process";
import { DevChestraError } from "@devchestra/core";
import { isGroupAlive, killTree, spawnIdentity } from "./identity.js";
import { materializeInvocation } from "./invocation.js";
import { boundTail, redacted, spawnFailure, waitSpawn, writeStdin } from "./spawn-util.js";
import type {
  AdapterEvent,
  ExitInfo,
  Invocation,
  RunHooks,
  RunOpts,
  TranscriptEntry,
} from "./types.js";

const DEFAULT_GRACE = 5_000;
const DEFAULT_MAX_LINE = 8 * 1024 * 1024;
const DEFAULT_STDERR = 256 * 1024;
const DEFAULT_TAIL = 64 * 1024;
const TRANSCRIPT_MAX = 16 * 1024;

function bound(text: string, max = TRANSCRIPT_MAX): string {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[… ${size - max} bytes omitted …]\n${text.slice(-half)}`;
}

function transcriptFor(event: AdapterEvent, ts: string): TranscriptEntry | null {
  switch (event.t) {
    case "session":
      return { ts, kind: "system", text: `session ${event.sessionId}` };
    case "text":
      return { ts, kind: "text", text: `${event.role}: ${event.text}` };
    case "tool_call": {
      let input = "";
      try {
        input = JSON.stringify(event.input);
      } catch {
        input = "[unserializable]";
      }
      return { ts, kind: "tool", text: `${event.name} ${input}` };
    }
    case "tool_result":
      return { ts, kind: "tool_result", text: `${event.ok ? "ok" : "error"}: ${event.summary}` };
    case "usage":
      return { ts, kind: "system", text: `usage ${JSON.stringify(event)}` };
    case "turn_end":
      return { ts, kind: "system", text: `turn_end isError=${String(event.isError)}` };
    case "notice":
      return { ts, kind: "notice", text: `${event.level}: ${event.text}` };
    case "raw":
      return { ts, kind: "raw", text: event.line };
  }
}

class LineSink {
  readonly #max: number;
  readonly #onLine: (line: Buffer, truncated: boolean) => Promise<void>;
  #parts: Buffer[] = [];
  #size = 0;
  #truncated = false;

  constructor(max: number, onLine: (line: Buffer, truncated: boolean) => Promise<void>) {
    this.#max = max;
    this.#onLine = onLine;
  }

  async feed(chunk: Buffer): Promise<void> {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      this.#add(chunk.subarray(start, end));
      if (newline === -1) return;
      await this.flush();
      start = newline + 1;
    }
  }

  async flush(): Promise<void> {
    if (this.#size === 0 && !this.#truncated) return;
    const line = Buffer.concat(this.#parts);
    const truncated = this.#truncated;
    this.#parts = [];
    this.#size = 0;
    this.#truncated = false;
    await this.#onLine(line, truncated);
  }

  #add(chunk: Buffer): void {
    const room = this.#max - this.#size;
    if (room <= 0) {
      this.#truncated = true;
      return;
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#parts.push(Buffer.from(slice));
    this.#size += slice.length;
    if (slice.length < chunk.length) this.#truncated = true;
  }
}

export async function runAgent(
  inv: Invocation,
  hooks: RunHooks,
  signal: AbortSignal,
  opts: RunOpts,
): Promise<ExitInfo> {
  if (signal.aborted) throw new DevChestraError("E_CANCELLED", "Run was cancelled before spawn");
  await materializeInvocation(inv);

  const startedAt = Date.now();
  const maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE;
  const maxStderr = opts.maxStderrBytes ?? DEFAULT_STDERR;
  const maxTail = opts.maxStdoutTailBytes ?? DEFAULT_TAIL;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderr = "";
  let stdoutTail = "";
  let sawTurnEnd = false;
  let killedBy: ExitInfo["killedBy"] = null;
  let killStarted = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let pending: Promise<void> = Promise.resolve();
  let lastTool = "";
  let repeats = 0;
  let silenceTimer: NodeJS.Timeout | undefined;

  const child = spawn(inv.bin, inv.args, {
    cwd: inv.cwd,
    env: inv.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await waitSpawn(child);
  } catch (error) {
    throw spawnFailure(error);
  }
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    throw new DevChestraError("E_INTERNAL", "Spawned child has no pid");
  }
  child.on("error", () => undefined);

  const kill = (reason: "timeout" | "cancel"): void => {
    if (killedBy === null) killedBy = reason;
    if (killStarted) return;
    killStarted = true;
    void killTree(pid, { graceMs });
  };

  const armSilence = (): void => {
    if (opts.silenceMs === undefined) return;
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      hooks.onWatchdog?.("silence", `${opts.silenceMs}ms without output`);
      armSilence();
    }, opts.silenceMs);
    silenceTimer.unref();
  };

  const armed = setTimeout(() => kill("timeout"), Math.max(1, opts.timeoutMs));
  armSilence();
  const onAbort = (): void => kill("cancel");
  signal.addEventListener("abort", onAbort, { once: true });

  const emit = async (events: AdapterEvent[]): Promise<void> => {
    for (const event of events) {
      const safe = event.t === "raw" ? { ...event, line: redacted(hooks, event.line) } : event;
      if (safe.t === "turn_end") sawTurnEnd = true;
      if (safe.t === "tool_call") {
        let key = safe.name;
        try {
          key += JSON.stringify(safe.input);
        } catch {
          key += String(safe.id);
        }
        if (key === lastTool) repeats += 1;
        else {
          lastTool = key;
          repeats = 1;
        }
        if (repeats === 8) hooks.onWatchdog?.("repeat", safe.name);
      }
      await hooks.onEvent?.(safe);
      const entry = transcriptFor(safe, new Date().toISOString());
      if (entry !== null && hooks.onTranscript !== undefined) {
        await hooks.onTranscript({ ...entry, text: bound(redacted(hooks, entry.text)) });
      }
    }
  };

  const parser = opts.parser;
  const sink = new LineSink(maxLine, async (line, truncated) => {
    if (truncated) {
      await emit([{ t: "raw", line: `${line.toString("utf8")}…[truncated:${maxLine} bytes]` }]);
      return;
    }
    if (line.length === 0) return;
    await emit(parser.feed(Buffer.concat([line, Buffer.from("\n")])));
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdoutTail = boundTail(stdoutTail + chunk.toString("utf8"), maxTail);
    armSilence();
    child.stdout?.pause();
    chain = chain
      .then(() => sink.feed(chunk))
      .catch(() => undefined)
      .finally(() => {
        if (!closed) child.stdout?.resume();
      });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    armSilence();
    const text = redacted(hooks, chunk.toString("utf8"));
    stderr = boundTail(stderr + text, maxStderr);
    hooks.onStderr?.(text);
    if (hooks.onTranscript !== undefined) {
      const entry = { ts: new Date().toISOString(), kind: "stderr" as const, text: bound(text) };
      pending = pending
        .then(() => hooks.onTranscript?.({ ...entry, text: redacted(hooks, entry.text) }))
        .catch(() => undefined);
    }
  });

  const closePromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, sig) =>
      resolve({ code, signal: sig === null ? null : String(sig) }),
    );
  });

  try {
    if (hooks.onSpawn !== undefined) {
      await hooks.onSpawn(await spawnIdentity(pid, inv.cwd, opts.generation ?? 1));
    }
    if (!killStarted) writeStdin(child, inv.stdin);
  } catch (error) {
    kill("cancel");
    throw error;
  }

  const { code, signal: closeSignal } = await closePromise;
  closed = true;
  clearTimeout(armed);
  if (silenceTimer !== undefined) clearTimeout(silenceTimer);
  signal.removeEventListener("abort", onAbort);
  await chain.catch(() => undefined);
  await pending.catch(() => undefined);
  try {
    await sink.flush();
    await emit(parser.end());
  } catch {
    // A hostile hook or parser must not hide the exit status.
  }
  if (isGroupAlive(pid)) await killTree(pid, { graceMs: 0 }).catch(() => undefined);
  const groupStopped = !isGroupAlive(pid);

  return {
    code,
    signal: closeSignal,
    killedBy,
    durationMs: Date.now() - startedAt,
    pid,
    stdoutBytes,
    stderrBytes,
    sawTurnEnd,
    groupStopped,
    tail: { stderr, stdout: stdoutTail },
  };
}
