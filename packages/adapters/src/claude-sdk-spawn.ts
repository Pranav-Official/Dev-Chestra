import { type ChildProcess, spawn } from "node:child_process";
import { Transform, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "./claude-model-normalizer.js";
import { isGroupAlive, killTree } from "./identity.js";

const GUARD_MAX_BYTES = 1024 * 1024;

export interface ClaudeSpawnLimits {
  maxStdoutBytes: number;
  maxStderrBytes: number;
  graceMs: number;
}

export interface ClaudeSpawnHooks {
  onLimit?: (stream: "stdout" | "stderr") => void;
  onViolation?: () => void;
  onMissing?: () => void;
}

export interface ClaudeOwnedProcess {
  process: SpawnedProcess;
  pid: number | null;
  readonly missing: boolean;
  /** Resolves when the child emits exit/error (best effort). */
  exited: Promise<void>;
  /** SIGTERM then SIGKILL the owned group; resolves true only when it is gone. */
  stop(): Promise<boolean>;
}

interface GuardState {
  initializeId: string | null;
  initializeSeen: boolean;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TakenFrame {
  json: string;
  rest: string;
  invalid?: true;
}

function takeFrame(buffer: string): TakenFrame | null {
  let start = 0;
  while (start < buffer.length && isWhitespace(buffer[start] ?? "")) start += 1;
  if (start >= buffer.length) return null;
  if (buffer[start] !== "{") return { json: "", rest: "", invalid: true };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < buffer.length; index += 1) {
    const char = buffer[index] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        while (end < buffer.length && isWhitespace(buffer[end] ?? "")) end += 1;
        return { json: buffer.slice(start, index + 1), rest: buffer.slice(end) };
      }
    }
  }
  return null;
}

function frameAllowed(frame: unknown, state: GuardState): boolean {
  if (!isRecord(frame)) return false;
  const type = frame.type;
  if (type === "control_request") {
    if (!isRecord(frame.request)) return false;
    if (frame.request.subtype !== "initialize" || state.initializeSeen) return false;
    state.initializeSeen = true;
    state.initializeId = typeof frame.request_id === "string" ? frame.request_id : null;
    return true;
  }
  if (type === "control_cancel_request") {
    return state.initializeId !== null && frame.request_id === state.initializeId;
  }
  return false;
}

export interface ClaudeStdinGuardHooks {
  forward: (text: string, callback: (error?: Error | null) => void) => void;
  end: (callback: (error?: Error | null) => void) => void;
  onViolation: () => void;
}

/**
 * A fail-closed NDJSON gate: only the metadata initialize request and its
 * cancel may reach the CLI. Prompt/turn/tool/session frames (including forged
 * permission responses) are dropped before delivery and reported.
 */
export function createClaudeStdinGuard(hooks: ClaudeStdinGuardHooks): Writable {
  const decoder = new StringDecoder("utf8");
  const state: GuardState = { initializeId: null, initializeSeen: false };
  let buffer = "";
  let blocked = false;

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (blocked) {
        callback();
        return;
      }
      buffer += decoder.write(chunk);
      if (buffer.length > GUARD_MAX_BYTES) {
        blocked = true;
        hooks.onViolation();
        callback();
        return;
      }

      let out = "";
      for (;;) {
        const taken = takeFrame(buffer);
        if (taken === null) break;
        buffer = taken.rest;
        if (taken.invalid === true) {
          blocked = true;
          hooks.onViolation();
          callback();
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(taken.json);
        } catch {
          blocked = true;
          hooks.onViolation();
          callback();
          return;
        }
        if (!frameAllowed(frame, state)) {
          blocked = true;
          hooks.onViolation();
          callback();
          return;
        }
        out += `${taken.json}\n`;
      }

      if (out === "") {
        callback();
        return;
      }
      try {
        hooks.forward(out, callback);
      } catch (error) {
        callback(error instanceof Error ? error : new Error("forward failed"));
      }
    },
    final(callback) {
      if (!blocked) {
        buffer += decoder.end();
        if (buffer.trim() !== "") {
          blocked = true;
          hooks.onViolation();
        }
      }
      if (blocked) {
        callback();
        return;
      }
      try {
        hooks.end(callback);
      } catch (error) {
        callback(error instanceof Error ? error : new Error("end failed"));
      }
    },
  });
}

function childStdin(child: ChildProcess): Writable {
  const stdin = child.stdin;
  if (stdin === null) {
    return new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }
  return stdin;
}

/** Spawn the pinned CLI in its own process group and gate every stdin frame. */
export function spawnClaudeForDiscovery(
  options: SpawnOptions,
  limits: ClaudeSpawnLimits,
  hooks: ClaudeSpawnHooks,
): ClaudeOwnedProcess {
  let missing = false;
  const child = spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid ?? null;

  let stdoutBytes = 0;
  let stderrBytes = 0;

  const stdout = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxStdoutBytes) {
        hooks.onLimit?.("stdout");
        callback(new Error("stdout limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  stdout.on("error", () => undefined);

  const stderrSink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stderrBytes += chunk.length;
      if (stderrBytes > limits.maxStderrBytes) {
        hooks.onLimit?.("stderr");
        callback(new Error("stderr limit"));
        return;
      }
      callback();
    },
  });
  stderrSink.on("error", () => undefined);

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderrSink);

  const stdin = createClaudeStdinGuard({
    forward: (text, callback) => {
      const target = childStdin(child);
      if (target.destroyed) {
        callback();
        return;
      }
      target.write(text, (error) => callback(error ?? null));
    },
    end: (callback) => {
      const target = childStdin(child);
      if (target.destroyed) {
        callback();
        return;
      }
      try {
        target.end(() => callback());
      } catch (error) {
        callback(error instanceof Error ? error : new Error("end failed"));
      }
    },
    onViolation: () => hooks.onViolation?.(),
  });

  let exitedResolve: (() => void) | null = null;
  const exited = new Promise<void>((resolve) => {
    exitedResolve = resolve;
  });
  const settle = (): void => {
    exitedResolve?.();
    exitedResolve = null;
  };
  child.once("exit", settle);
  child.once("error", settle);
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      missing = true;
      hooks.onMissing?.();
    }
  });

  const process = {
    stdin,
    stdout,
    get killed(): boolean {
      return child.killed;
    },
    get exitCode(): number | null {
      return child.exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return child.signalCode;
    },
    kill(signal: NodeJS.Signals): boolean {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  } as unknown as SpawnedProcess;

  let stopped = false;
  return {
    process,
    pid,
    get missing(): boolean {
      return missing;
    },
    exited,
    async stop(): Promise<boolean> {
      if (stopped) return !(pid !== null && isGroupAlive(pid));
      stopped = true;
      try {
        child.stdin?.end();
      } catch {
        // Pipe may already be closed.
      }
      if (pid !== null && isGroupAlive(pid)) {
        await Promise.race([exited, sleep(Math.min(limits.graceMs, 500))]);
        if (isGroupAlive(pid)) {
          await killTree(pid, { graceMs: limits.graceMs }).catch(() => undefined);
        }
      }
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
        stdout.destroy();
        stderrSink.destroy();
      } catch {
        // Best-effort teardown.
      }
      if (pid === null) return true;
      return !isGroupAlive(pid);
    },
  };
}
