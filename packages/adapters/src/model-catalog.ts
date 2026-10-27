import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isGroupAlive, killTree } from "./identity.js";
import { waitSpawn } from "./spawn-util.js";
import type {
  CodexModelDiscovery,
  CodexModelDiscoveryRequest,
  CodexModelDiscoveryStatus,
  CodexModelItem,
} from "./types.js";

const TOTAL_MS = 15_000;
const INIT_MS = 5_000;
const IDLE_MS = 5_000;
const STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 64 * 1024;
const PAGES_MAX = 10;
const MODELS_MAX = 1000;
const GRACE_MS = 1_000;
const PAGE_LIMIT = 100;
const ID_MAX = 256;
const LABEL_MAX = 256;
const DESCRIPTION_MAX = 1024;
const PROVIDER_MAX = 128;
const ALIAS_MAX = 256;
const ALIASES_MAX = 32;
const CLIENT_VERSION = "0.1.0";

const MESSAGES = {
  invalidRequest: "Invalid model discovery request.",
  missing: "Codex CLI was not found.",
  unsupported: "Codex CLI does not support model discovery.",
  unavailable: "Codex model discovery is unavailable.",
  protocol: "Codex app-server returned an invalid response.",
  oversize: "Codex app-server output exceeded safe limits.",
  timeout: "Codex model discovery timed out.",
  cancelled: "Codex model discovery was cancelled.",
  closed: "Codex app-server closed the connection unexpectedly.",
  authRequired: "Codex requires authentication to list models.",
  stopFailed: "Codex model discovery could not stop its process.",
} as const;

class DiscoveryError extends Error {
  readonly status: CodexModelDiscoveryStatus;

  constructor(status: CodexModelDiscoveryStatus, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.status = status;
  }
}

function failure(status: CodexModelDiscoveryStatus, message: string): CodexModelDiscovery {
  return { status, items: [], cliVersion: null, truncated: false, message };
}

function success(
  items: CodexModelItem[],
  cliVersion: string | null,
  truncated: boolean,
): CodexModelDiscovery {
  return { status: "ready", items, cliVersion, truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(fallback, Math.max(1, Math.floor(value)));
}

function boundCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(fallback, Math.max(1, Math.floor(value)));
}

function validRequest(request: CodexModelDiscoveryRequest): boolean {
  if (typeof request.cwd !== "string" || request.cwd === "" || request.cwd.includes("\u0000")) {
    return false;
  }
  if (
    request.bin !== undefined &&
    (typeof request.bin !== "string" ||
      request.bin === "" ||
      request.bin.length > 4096 ||
      request.bin.includes("\u0000"))
  ) {
    return false;
  }
  if (!isRecord(request.env)) return false;
  for (const [name, value] of Object.entries(request.env)) {
    if (name === "" || name.includes("=") || name.includes("\u0000")) return false;
    if (typeof value !== "string" || value.includes("\u0000")) return false;
  }
  return true;
}

function rpcError(error: Record<string, unknown>): DiscoveryError {
  const code = typeof error.code === "number" ? error.code : undefined;
  if (code === -32601) return new DiscoveryError("unsupported", MESSAGES.unsupported);
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (
    code === 401 ||
    code === 403 ||
    /auth|login|log in|sign in|signin|unauthori[sz]ed|credential|token|api.?key|not logged/.test(
      message,
    )
  ) {
    return new DiscoveryError("authRequired", MESSAGES.authRequired);
  }
  return new DiscoveryError("unavailable", MESSAGES.unavailable);
}

function parseVersion(result: Record<string, unknown>): string | null {
  const server = isRecord(result.serverInfo) ? result.serverInfo : null;
  const candidates = [result.userAgent, result.user_agent, result.version, server?.version];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const match = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(value.slice(0, 256));
    if (match?.[1] !== undefined) return match[1].slice(0, 64);
  }
  return null;
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function safeId(value: string): boolean {
  return value.length > 0 && value.length <= ID_MAX && !hasControl(value);
}

function printable(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

function capped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

interface ParsedItem {
  rpcId: string;
  item: CodexModelItem;
}

function parseItem(value: unknown): ParsedItem | null {
  if (!isRecord(value)) return null;
  const rpcId = value.id;
  const model = value.model;
  if (typeof rpcId !== "string" || typeof model !== "string") return null;
  if (!safeId(rpcId) || !safeId(model)) return null;

  const label = capped(
    printable(typeof value.displayName === "string" ? value.displayName : ""),
    LABEL_MAX,
  );
  const item: CodexModelItem = {
    id: model,
    label: label === "" ? model : label,
    source: "codex-app-server",
  };

  if (typeof value.description === "string") {
    const description = capped(printable(value.description), DESCRIPTION_MAX);
    if (description !== "") item.description = description;
  }
  if (typeof value.provider === "string") {
    const provider = capped(printable(value.provider), PROVIDER_MAX);
    if (provider !== "") item.provider = provider;
  }
  if (Array.isArray(value.aliases)) {
    const aliases: string[] = [];
    for (const alias of value.aliases) {
      if (typeof alias !== "string") continue;
      const cleaned = capped(printable(alias), ALIAS_MAX);
      if (cleaned === "" || aliases.includes(cleaned)) continue;
      aliases.push(cleaned);
      if (aliases.length === ALIASES_MAX) break;
    }
    if (aliases.length > 0) item.aliases = aliases;
  }
  if (typeof value.isDefault === "boolean") item.isDefault = value.isDefault;
  return { rpcId, item };
}

async function stop(child: ChildProcess, pid: number | null, graceMs: number): Promise<boolean> {
  try {
    child.stdin?.end();
  } catch {
    // The pipe may already be closed.
  }
  try {
    child.stdout?.destroy();
    child.stderr?.destroy();
  } catch {
    // Best-effort teardown only.
  }
  if (pid === null) return true;
  if (isGroupAlive(pid)) {
    await killTree(pid, { graceMs }).catch(() => undefined);
    return !isGroupAlive(pid);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 100);
      timer.unref();
      child.once("close", done);
    });
  }
  return !isGroupAlive(pid) && (child.exitCode !== null || child.signalCode !== null);
}

function errorResult(error: unknown): CodexModelDiscovery {
  if (error instanceof DiscoveryError) return failure(error.status, error.message);
  return failure("unavailable", MESSAGES.unavailable);
}

/**
 * Bounded, metadata-only Codex catalog discovery over the documented app-server
 * JSON-RPC transport. Sends only initialize, initialized and model/list; never
 * starts a thread/turn, logs in, writes config or performs inference.
 */
export async function discoverCodexModels(
  request: CodexModelDiscoveryRequest,
): Promise<CodexModelDiscovery> {
  if (typeof request !== "object" || request === null) {
    return failure("unavailable", MESSAGES.invalidRequest);
  }
  if (!validRequest(request)) return failure("unavailable", MESSAGES.invalidRequest);

  const totalMs = boundMs(request.timeoutMs, TOTAL_MS);
  const initMs = boundMs(request.initTimeoutMs, Math.min(INIT_MS, totalMs));
  const idleMs = boundMs(request.idleTimeoutMs, Math.min(IDLE_MS, totalMs));
  const maxStdout = boundCount(request.maxStdoutBytes, STDOUT_MAX);
  const maxStderr = boundCount(request.maxStderrBytes, STDERR_MAX);
  const maxPages = boundCount(request.maxPages, PAGES_MAX);
  const maxModels = boundCount(request.maxModels, MODELS_MAX);
  const graceMs = boundMs(request.graceMs, GRACE_MS);
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, totalMs - (Date.now() - startedAt));

  const signal = request.signal;
  if (signal?.aborted === true) return failure("unavailable", MESSAGES.cancelled);

  let child: ChildProcess | null = null;
  let pid: number | null = null;
  let outcome: CodexModelDiscovery = failure("unavailable", MESSAGES.unavailable);
  let fatal: DiscoveryError | null = null;
  let pendingId: number | null = null;
  let pendingResolve: ((value: Record<string, unknown>) => void) | null = null;
  let pendingReject: ((error: DiscoveryError) => void) | null = null;
  let notifyFailure: ((error: DiscoveryError) => void) | null = null;
  let phase: "init" | "ready" = "init";
  let phaseTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutBuffer = "";
  let decoderEnded = false;
  let stopped = true;
  let finished = false;
  const decoder = new StringDecoder("utf8");

  const failureSignal = new Promise<never>((_, reject) => {
    notifyFailure = reject;
  });
  failureSignal.catch(() => undefined);

  const fail = (error: DiscoveryError): void => {
    if (fatal !== null) return;
    fatal = error;
    const notify = notifyFailure;
    notifyFailure = null;
    notify?.(error);
    const reject = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    pendingId = null;
    if (reject !== null) reject(error);
  };

  const clearPhase = (): void => {
    if (phaseTimer !== undefined) {
      clearTimeout(phaseTimer);
      phaseTimer = undefined;
    }
  };

  const armPhase = (ms: number): void => {
    clearPhase();
    if (fatal !== null) return;
    phaseTimer = setTimeout(
      () => fail(new DiscoveryError("unavailable", MESSAGES.timeout)),
      Math.max(1, Math.min(ms, remaining())),
    );
    phaseTimer.unref();
  };

  const onAbort = (): void => fail(new DiscoveryError("unavailable", MESSAGES.cancelled));
  signal?.addEventListener("abort", onAbort, { once: true });

  const settlePending = (value: Record<string, unknown>): void => {
    const resolve = pendingResolve;
    pendingResolve = null;
    pendingReject = null;
    pendingId = null;
    if (resolve !== null) resolve(value);
  };

  const waitFor = (id: number): Promise<Record<string, unknown>> => {
    if (fatal !== null) return Promise.reject(fatal);
    if (pendingResolve !== null) {
      return Promise.reject(new DiscoveryError("unavailable", MESSAGES.protocol));
    }
    pendingId = id;
    return new Promise((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });
  };

  const send = (message: Record<string, unknown>): void => {
    if (fatal !== null || child === null || child.stdin === null || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      fail(new DiscoveryError("unavailable", MESSAGES.unavailable));
    }
  };

  const handleLine = (line: string): void => {
    if (fatal !== null) return;
    if (phase === "ready") armPhase(idleMs);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new DiscoveryError("unavailable", MESSAGES.protocol));
      return;
    }
    if (!isRecord(message)) {
      fail(new DiscoveryError("unavailable", MESSAGES.protocol));
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        fail(new DiscoveryError("unsupported", MESSAGES.unsupported));
        return;
      }
      return;
    }
    if (typeof message.id !== "number") {
      fail(new DiscoveryError("unavailable", MESSAGES.protocol));
      return;
    }
    if (pendingId === null || message.id !== pendingId) {
      fail(new DiscoveryError("unavailable", MESSAGES.protocol));
      return;
    }
    settlePending(message);
  };

  const onStdout = (chunk: Buffer): void => {
    if (fatal !== null) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdout) {
      fail(new DiscoveryError("unavailable", MESSAGES.oversize));
      return;
    }
    stdoutBuffer += decoder.write(chunk);
    let index = stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim() !== "") handleLine(line);
      if (fatal !== null) return;
      index = stdoutBuffer.indexOf("\n");
    }
  };

  const onStdoutEnd = (): void => {
    if (!decoderEnded) {
      decoderEnded = true;
      stdoutBuffer += decoder.end();
    }
    if (stdoutBuffer.trim() !== "") {
      handleLine(stdoutBuffer);
      stdoutBuffer = "";
    }
    queueMicrotask(() => {
      if (!finished) fail(new DiscoveryError("unavailable", MESSAGES.closed));
    });
  };

  const onClose = (): void => {
    queueMicrotask(() => {
      if (!finished) fail(new DiscoveryError("unavailable", MESSAGES.closed));
    });
  };

  const onStderr = (chunk: Buffer): void => {
    if (fatal !== null) return;
    stderrBytes += chunk.length;
    if (stderrBytes > maxStderr) {
      fail(new DiscoveryError("unavailable", MESSAGES.oversize));
    }
  };

  const onRuntimeError = (): void => {
    if (!finished) fail(new DiscoveryError("unavailable", MESSAGES.unavailable));
  };

  let proc: ChildProcess;
  try {
    proc = spawn(request.bin ?? "codex", ["app-server", "--listen", "stdio://"], {
      cwd: request.cwd,
      env: { ...request.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    signal?.removeEventListener("abort", onAbort);
    return failure("unavailable", MESSAGES.unavailable);
  }
  child = proc;
  pid = proc.pid ?? null;
  proc.stdin?.on("error", () => undefined);
  proc.stdout?.on("data", onStdout);
  proc.stdout?.on("end", onStdoutEnd);
  proc.stderr?.on("data", onStderr);
  proc.once("close", onClose);

  totalTimer = setTimeout(
    () => fail(new DiscoveryError("unavailable", MESSAGES.timeout)),
    Math.max(1, totalMs),
  );
  totalTimer.unref();

  try {
    if (fatal !== null) throw fatal;
    try {
      await Promise.race([waitSpawn(proc), failureSignal]);
    } catch (error) {
      if (fatal !== null) throw fatal;
      const code = (error as NodeJS.ErrnoException).code;
      throw new DiscoveryError(
        "unavailable",
        code === "ENOENT" ? MESSAGES.missing : MESSAGES.unavailable,
      );
    }
    if (pid === null) throw new DiscoveryError("unavailable", MESSAGES.unavailable);
    proc.on("error", onRuntimeError);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "relay", title: "Relay", version: CLIENT_VERSION } },
    });
    armPhase(initMs);
    const init = await waitFor(1);
    if (init.error !== undefined && init.error !== null) {
      if (!isRecord(init.error)) {
        throw new DiscoveryError("unavailable", MESSAGES.protocol);
      }
      throw rpcError(init.error);
    }
    if (!isRecord(init.result)) throw new DiscoveryError("unavailable", MESSAGES.protocol);
    const cliVersion = parseVersion(init.result);

    phase = "ready";
    armPhase(idleMs);
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    const items: CodexModelItem[] = [];
    const seenCursors = new Set<string>();
    const seenRpcIds = new Set<string>();
    const seenModels = new Set<string>();
    let cursor: string | undefined;
    let page = 0;
    let nextId = 2;
    let truncated = false;

    for (;;) {
      if (page >= maxPages) {
        truncated = true;
        break;
      }
      const params: Record<string, unknown> = { includeHidden: false, limit: PAGE_LIMIT };
      if (cursor !== undefined) params.cursor = cursor;
      const id = nextId;
      nextId += 1;
      send({ jsonrpc: "2.0", id, method: "model/list", params });
      armPhase(idleMs);
      const response = await waitFor(id);
      if (response.error !== undefined && response.error !== null) {
        if (!isRecord(response.error)) {
          throw new DiscoveryError("unavailable", MESSAGES.protocol);
        }
        throw rpcError(response.error);
      }
      if (!isRecord(response.result)) throw new DiscoveryError("unavailable", MESSAGES.protocol);
      const data = response.result.data;
      if (!Array.isArray(data)) throw new DiscoveryError("unavailable", MESSAGES.protocol);
      const nextCursor = response.result.nextCursor;
      if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
        throw new DiscoveryError("unavailable", MESSAGES.protocol);
      }

      let dropped = false;
      for (const raw of data) {
        if (!isRecord(raw)) throw new DiscoveryError("unavailable", MESSAGES.protocol);
        if (raw.hidden === true) continue;
        const parsed = parseItem(raw);
        if (parsed === null) {
          dropped = true;
          continue;
        }
        if (seenRpcIds.has(parsed.rpcId)) continue;
        seenRpcIds.add(parsed.rpcId);
        if (seenModels.has(parsed.item.id)) continue;
        seenModels.add(parsed.item.id);
        if (items.length >= maxModels) {
          truncated = true;
          break;
        }
        items.push(parsed.item);
      }
      if (dropped) truncated = true;
      page += 1;
      if (nextCursor === null || nextCursor === undefined) break;
      if (items.length >= maxModels) {
        truncated = true;
        break;
      }
      if (nextCursor === "" || seenCursors.has(nextCursor)) {
        truncated = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    outcome = success(items, cliVersion, truncated);
  } catch (error) {
    outcome = errorResult(error);
  } finally {
    finished = true;
    clearPhase();
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onAbort);
    proc.stdout?.removeListener("data", onStdout);
    proc.stdout?.removeListener("end", onStdoutEnd);
    proc.stderr?.removeListener("data", onStderr);
    proc.removeListener("close", onClose);
    proc.removeListener("error", onRuntimeError);
    stopped = await stop(proc, pid, graceMs);
  }

  if (!stopped) return failure("unavailable", MESSAGES.stopFailed);
  return outcome;
}
