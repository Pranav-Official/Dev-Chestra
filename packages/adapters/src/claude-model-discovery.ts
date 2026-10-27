import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  type Options,
  type Query,
  query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeFailureReason,
  type ClaudeLimits,
  ClaudeNormalizeError,
  classifyClaudeError,
  claudeFailure,
  claudeLimits,
  isRecord,
  normalizeInitialization,
} from "./claude-model-normalizer.js";
import { type ClaudeOwnedProcess, spawnClaudeForDiscovery } from "./claude-sdk-spawn.js";
import type { ClaudeModelDiscovery, ClaudeModelDiscoveryRequest } from "./types.js";

class ClaudeFailure extends Error {
  readonly reason: ClaudeFailureReason;

  constructor(reason: ClaudeFailureReason) {
    super(reason);
    this.name = "ClaudeFailure";
    this.reason = reason;
  }
}

interface IdlePrompt {
  iterable: AsyncIterable<SDKUserMessage>;
  dispose: () => void;
}

/** A prompt stream that parks forever and yields no message. */
function idlePrompt(): IdlePrompt {
  let resolveDone: (() => void) | null = null;
  let done = false;
  const pending = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    resolveDone = () => resolve({ done: true, value: undefined });
  });
  const finish = (): void => {
    if (done) return;
    done = true;
    const resolveOnce = resolveDone;
    resolveDone = null;
    resolveOnce?.();
  };
  const iterator: AsyncIterator<SDKUserMessage> & AsyncIterable<SDKUserMessage> = {
    next: () => (done ? Promise.resolve({ done: true, value: undefined }) : pending),
    return: () => {
      finish();
      return Promise.resolve({ done: true, value: undefined });
    },
    throw: (error?: unknown) => {
      finish();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { iterable: iterator, dispose: () => void iterator.return?.() };
}

function validRequest(value: unknown): value is ClaudeModelDiscoveryRequest {
  if (!isRecord(value)) return false;
  if (typeof value.cwd !== "string" || value.cwd === "" || value.cwd.includes("\u0000")) {
    return false;
  }
  if (
    value.bin !== undefined &&
    (typeof value.bin !== "string" ||
      value.bin === "" ||
      value.bin.length > 4096 ||
      value.bin.includes("\u0000"))
  ) {
    return false;
  }
  if (!isRecord(value.env)) return false;
  for (const [name, item] of Object.entries(value.env)) {
    if (name === "" || name.includes("=") || name.includes("\u0000")) return false;
    if (typeof item !== "string" || item.includes("\u0000")) return false;
  }
  if (value.signal !== undefined) {
    const signal = value.signal as { aborted?: unknown; addEventListener?: unknown };
    if (typeof signal.addEventListener !== "function") return false;
  }
  return true;
}

function resolveClaudeBin(
  bin: string | undefined,
  env: Record<string, string>,
  cwd: string,
): string | null {
  const candidates: string[] = [];
  if (bin !== undefined) {
    if (bin.includes("/") || isAbsolute(bin)) {
      candidates.push(isAbsolute(bin) ? resolve(bin) : resolve(cwd, bin));
    } else {
      for (const entry of (env.PATH ?? "").split(delimiter)) {
        if (entry === "") continue;
        candidates.push(isAbsolute(entry) ? join(entry, bin) : resolve(cwd, entry, bin));
      }
    }
  } else {
    for (const entry of (env.PATH ?? "").split(delimiter)) {
      if (entry === "") continue;
      candidates.push(isAbsolute(entry) ? join(entry, "claude") : resolve(cwd, entry, "claude"));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function sdkOptions(
  request: ClaudeModelDiscoveryRequest,
  bin: string,
  abort: AbortController,
  spawnProcess: (options: SpawnOptions) => SpawnedProcess,
): Options {
  return {
    pathToClaudeCodeExecutable: bin,
    cwd: request.cwd,
    env: request.env,
    settingSources: ["user", "project", "local"],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    permissionMode: "dontAsk",
    plugins: [],
    persistSession: false,
    abortController: abort,
    spawnClaudeCodeProcess: spawnProcess,
  };
}

function readyResult(value: unknown, limits: ClaudeLimits): ClaudeModelDiscovery {
  const normalized = normalizeInitialization(value, limits.maxModels);
  return {
    status: "ready",
    items: normalized.items,
    cliVersion: normalized.cliVersion,
    truncated: normalized.truncated,
  };
}

/**
 * Discover the Claude Code model catalog through the public Claude Agent SDK
 * initialize handshake only. The prompt is a never-yielding AsyncIterable, so
 * no user frame, turn, tool, session or model request is sent. Every stdin
 * frame is gated before delivery and the child is terminated as an owned group.
 */
export async function discoverClaudeModels(
  request: ClaudeModelDiscoveryRequest,
): Promise<ClaudeModelDiscovery> {
  if (!validRequest(request)) return claudeFailure("invalid");
  if (request.signal?.aborted === true) return claudeFailure("cancelled");

  const limits = claudeLimits(request);
  const bin = resolveClaudeBin(request.bin, request.env, request.cwd);
  if (bin === null) return claudeFailure("missing");

  const prompt = idlePrompt();
  const abort = new AbortController();
  let reason: ClaudeFailureReason | null = null;
  let rejectFailure: ((error: ClaudeFailure) => void) | null = null;
  const failureSignal = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  failureSignal.catch(() => undefined);

  const fail = (next: ClaudeFailureReason): void => {
    if (reason !== null) return;
    reason = next;
    try {
      abort.abort();
    } catch {
      // Abort is best effort.
    }
    const rejectOnce = rejectFailure;
    rejectFailure = null;
    rejectOnce?.(new ClaudeFailure(next));
  };

  const onAbort = (): void => fail("cancelled");
  request.signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => fail("timeout"), limits.totalMs);
  timer.unref();

  const ownedRef: { current: ClaudeOwnedProcess | null } = { current: null };
  let handle: Query | null = null;
  let outcome: ClaudeModelDiscovery | null = null;

  try {
    if (reason !== null) throw new ClaudeFailure(reason);
    handle = query({
      prompt: prompt.iterable,
      options: sdkOptions(request, bin, abort, (spawnOptions) => {
        const spawned = spawnClaudeForDiscovery(
          spawnOptions,
          {
            maxStdoutBytes: limits.maxStdoutBytes,
            maxStderrBytes: limits.maxStderrBytes,
            graceMs: limits.graceMs,
          },
          {
            onLimit: () => fail("oversize"),
            onViolation: () => fail("blocked"),
            onMissing: () => fail("missing"),
          },
        );
        ownedRef.current = spawned;
        return spawned.process;
      }),
    });

    const initialization = handle.initializationResult();
    initialization.catch(() => undefined);
    const value = await Promise.race([initialization, failureSignal]);
    outcome = readyResult(value, limits);
  } catch (error) {
    if (reason !== null) {
      outcome = claudeFailure(reason);
    } else if (error instanceof ClaudeNormalizeError) {
      outcome = claudeFailure(error.reason);
    } else if (error instanceof ClaudeFailure) {
      outcome = claudeFailure(error.reason);
    } else if (ownedRef.current?.missing === true) {
      outcome = claudeFailure("missing");
    } else {
      outcome = classifyClaudeError(error);
    }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    prompt.dispose();
    if (handle !== null) {
      try {
        handle.close();
      } catch {
        // Close is best effort.
      }
    }
    const owned = ownedRef.current;
    if (owned !== null) {
      const stopped = await owned.stop();
      if (!stopped) outcome = claudeFailure("stop");
    }
  }

  return outcome ?? claudeFailure(reason ?? "unavailable");
}
