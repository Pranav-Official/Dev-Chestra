import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExecutionIdentity } from "@devchestra/core";
import type { ShellPolicy } from "@devchestra/schema";
import { DevChestraError } from "./errors.js";

/** A cached command result shared by the runner and execution-token registry. */
export interface ExecOutcome {
  text: string;
  isError: boolean;
}

/** One transcript-facing event from an exec call; text is already redacted by the engine. */
export interface ExecToolEvent {
  kind: "tool" | "tool_result";
  text: string;
}

/**
 * Server-owned shell policy for one run, frozen into the exec token at mint
 * time. Never read from tool arguments. `onToolEvent` is a function, so it is
 * copied by reference and never passed through structuredClone.
 */
export interface ExecShellScope {
  policy: ShellPolicy;
  /** Absolute, real workspace directory (exec runs here, fixed). */
  cwd: string;
  /** Allowlisted child env. Must not carry provider credentials. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  onToolEvent?: (event: ExecToolEvent) => void;
}

export interface ExecScope {
  identity: ExecutionIdentity;
  toolset: "agent" | "supervisor";
  /** Ajv schema handed to submit_result; the token is the only source of this. */
  outputSchema: Record<string, unknown>;
  outputSchemaHash: string;
  /** Total submissions allowed for this attempt, including the first one. */
  validationLimit: number;
  /** Absolute epoch milliseconds after which the token is invalid. */
  expiresAt: number;
  /** Present only for agents with a shell policy; enables the `exec` tool. */
  shell?: ExecShellScope;
}

/** Most distinct exec calls one token may issue. */
export const EXEC_CALL_LIMIT = 1000;
/**
 * Most completed exec output one token keeps for replaying a retried call. Past it, the oldest
 * results are replaced by a short marker; a retry of such a call is answered with the marker and
 * never runs the command again.
 */
export const EXEC_RECEIPT_BUDGET_BYTES = 4 * 1024 * 1024;
const EXEC_EVICTED_OUTCOME: ExecOutcome = {
  text: "The output of this call is no longer retained. It already ran; do not repeat it.",
  isError: true,
};

/** Tools that share one call-id namespace per token. */
export type CallTool = "exec" | "submit_result";

export interface ExecTokenRegistryOptions {
  /** Retained exec output per token, in bytes. Defaults to {@link EXEC_RECEIPT_BUDGET_BYTES}. */
  execReceiptBudgetBytes?: number;
  /**
   * Optional persistence-sink hook. The composition root registers the bearer
   * with the store's secret guard and receives a release callback. The token
   * value itself is never retained by the registry.
   */
  registerSecret?: (token: string, name?: string) => (() => void) | undefined;
}

interface ExecCall {
  /** sha256 of the command, so a reused id with other arguments is caught without keeping the text. */
  fingerprint: string;
  result: Promise<ExecOutcome>;
  /** Bytes of retained output; zero until the call completes. */
  bytes: number;
}

interface TokenEntry {
  digest: Buffer;
  scope: ExecScope;
  release?: () => void;
  abort: AbortController;
  calls: Map<string, ExecCall>;
  retainedBytes: number;
  /** Ids already used for submit_result; an exec may not reuse them. */
  submitCalls: Set<string>;
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  return value;
}

function cloneShell(shell: ExecShellScope): ExecShellScope {
  const copy: ExecShellScope = {
    policy: structuredClone(shell.policy),
    cwd: shell.cwd,
    env: { ...shell.env },
    timeoutMs: shell.timeoutMs,
    maxOutputBytes: shell.maxOutputBytes,
  };
  if (shell.onToolEvent !== undefined) copy.onToolEvent = shell.onToolEvent;
  return copy;
}

function cloneScope(scope: ExecScope): ExecScope {
  const shell = scope.shell === undefined ? undefined : cloneShell(scope.shell);
  return deepFreeze({
    identity: {
      runId: scope.identity.runId,
      path: scope.identity.path,
      attempt: scope.identity.attempt,
      generation: scope.identity.generation,
    },
    toolset: scope.toolset,
    outputSchema: structuredClone(scope.outputSchema),
    outputSchemaHash: scope.outputSchemaHash,
    validationLimit: scope.validationLimit,
    expiresAt: scope.expiresAt,
    ...(shell === undefined ? {} : { shell }),
  });
}

function validateShell(shell: ExecShellScope): void {
  if (typeof shell.cwd !== "string" || !isAbsolute(shell.cwd)) {
    throw new Error("ExecScope shell cwd must be an absolute path.");
  }
  if (!Number.isSafeInteger(shell.timeoutMs) || shell.timeoutMs < 1) {
    throw new Error("ExecScope shell timeoutMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(shell.maxOutputBytes) || shell.maxOutputBytes < 1) {
    throw new Error("ExecScope shell maxOutputBytes must be a positive integer.");
  }
  if (typeof shell.policy !== "object" || shell.policy === null) {
    throw new Error("ExecScope shell policy is required.");
  }
}

function validateScope(scope: ExecScope, now: number): void {
  if (typeof scope.identity.runId !== "string" || scope.identity.runId === "") {
    throw new Error("ExecScope runId is required.");
  }
  if (typeof scope.identity.path !== "string" || scope.identity.path === "") {
    throw new Error("ExecScope path is required.");
  }
  if (!Number.isSafeInteger(scope.identity.attempt) || scope.identity.attempt < 1) {
    throw new Error("ExecScope attempt must be >= 1.");
  }
  if (!Number.isSafeInteger(scope.identity.generation) || scope.identity.generation < 1) {
    throw new Error("ExecScope generation must be >= 1.");
  }
  if (scope.toolset !== "agent" && scope.toolset !== "supervisor") {
    throw new Error("ExecScope toolset must be agent or supervisor.");
  }
  if (
    typeof scope.outputSchema !== "object" ||
    scope.outputSchema === null ||
    Array.isArray(scope.outputSchema)
  ) {
    throw new Error("ExecScope outputSchema must be an object.");
  }
  if (typeof scope.outputSchemaHash !== "string" || scope.outputSchemaHash === "") {
    throw new Error("ExecScope outputSchemaHash is required.");
  }
  if (!Number.isSafeInteger(scope.validationLimit) || scope.validationLimit < 1) {
    throw new Error("ExecScope validationLimit must be >= 1.");
  }
  if (!Number.isFinite(scope.expiresAt) || scope.expiresAt <= now) {
    throw new Error("ExecScope expiresAt must be a finite future timestamp.");
  }
  if (scope.shell !== undefined) validateShell(scope.shell);
}

/**
 * In-memory exec-token registry. Only sha256(token) is retained, never the
 * bearer value. Tokens are bound to a frozen, server-owned execution identity;
 * a model can never choose run/path/attempt/generation through a tool call.
 */
export class ExecTokenRegistry {
  readonly #entries = new Map<string, TokenEntry>();
  readonly #retired = new Map<string, TokenEntry>();
  readonly #registerSecret: ExecTokenRegistryOptions["registerSecret"];
  readonly #receiptBudget: number;

  constructor(options: ExecTokenRegistryOptions = {}) {
    this.#registerSecret = options.registerSecret;
    this.#receiptBudget = options.execReceiptBudgetBytes ?? EXEC_RECEIPT_BUDGET_BYTES;
  }

  issue(scope: ExecScope, now: number = Date.now()): string {
    validateScope(scope, now);
    const frozen = cloneScope(scope);
    const token = randomBytes(32).toString("base64url");
    const release = this.#registerSecret?.(token, "exec-token");
    const entry: TokenEntry = {
      digest: digestToken(token),
      scope: frozen,
      abort: new AbortController(),
      calls: new Map(),
      retainedBytes: 0,
      submitCalls: new Set(),
    };
    if (typeof release === "function") {
      entry.release = release;
    }
    this.#entries.set(entry.digest.toString("hex"), entry);
    return token;
  }

  /** Resolve a bearer value in constant time; expired entries are removed. */
  resolve(token: string, now: number = Date.now()): ExecScope | null {
    if (typeof token !== "string" || token.length === 0 || token.length > 512) {
      return null;
    }
    const digest = digestToken(token);
    const key = digest.toString("hex");
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (!timingSafeEqual(entry.digest, digest)) {
      return null;
    }
    if (now >= entry.scope.expiresAt) {
      this.#delete(key, entry);
      return null;
    }
    return entry.scope;
  }

  /**
   * Join duplicate calls for this token; never repeat a side effect on transport retry. The
   * registry keeps only a fingerprint of the command and a bounded amount of finished output, so
   * a client cannot grow server memory by issuing many or large calls.
   */
  execute(
    token: string,
    callId: string,
    command: string,
    run: (signal: AbortSignal) => Promise<ExecOutcome>,
    now: number,
  ): Promise<ExecOutcome> {
    if (this.resolve(token, now) === null)
      throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
    const entry = this.#entries.get(digestToken(token).toString("hex"));
    if (entry === undefined)
      throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
    const fingerprint = createHash("sha256").update(command).digest("hex");
    const existing = entry.calls.get(callId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        throw new DevChestraError(
          "E_CONFLICT",
          "Call ID was already used with different arguments.",
        );
      return existing.result;
    }
    if (entry.submitCalls.has(callId))
      throw new DevChestraError("E_CONFLICT", "Call ID was already used by a different tool.");
    if (entry.calls.size >= EXEC_CALL_LIMIT)
      throw new DevChestraError("E_FORBIDDEN", "Execution call limit reached.");
    const call: ExecCall = {
      fingerprint,
      result: Promise.resolve().then(() => run(entry.abort.signal)),
      bytes: 0,
    };
    entry.calls.set(callId, call);
    void call.result.then(
      (outcome) => {
        call.bytes = Buffer.byteLength(outcome.text);
        entry.retainedBytes += call.bytes;
        this.#trim(entry);
      },
      () => undefined,
    );
    return call.result;
  }

  /**
   * Claim a call id for submit_result. An id already used by an exec is refused, so one id can
   * never trigger two different tools. The same tool may reuse its own id (a retry).
   */
  claimSubmitCall(token: string, callId: string, now: number): void {
    if (this.resolve(token, now) === null)
      throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
    const entry = this.#entries.get(digestToken(token).toString("hex"));
    if (entry === undefined)
      throw new DevChestraError("E_AUTH", "The execution token is no longer valid.");
    if (entry.calls.has(callId))
      throw new DevChestraError("E_CONFLICT", "Call ID was already used by a different tool.");
    if (entry.submitCalls.size >= EXEC_CALL_LIMIT && !entry.submitCalls.has(callId))
      throw new DevChestraError("E_FORBIDDEN", "Call limit reached.");
    entry.submitCalls.add(callId);
  }

  /** Replace the oldest finished results with a marker until the retained output fits the budget. */
  #trim(entry: TokenEntry): void {
    if (entry.retainedBytes <= this.#receiptBudget) return;
    const markerBytes = Buffer.byteLength(EXEC_EVICTED_OUTCOME.text);
    for (const call of entry.calls.values()) {
      if (entry.retainedBytes <= this.#receiptBudget) return;
      if (call.bytes <= markerBytes) continue;
      entry.retainedBytes -= call.bytes - markerBytes;
      call.bytes = markerBytes;
      call.result = Promise.resolve(EXEC_EVICTED_OUTCOME);
    }
  }

  /** Wait until all commands stopped after token revocation. */
  async drain(token: string): Promise<void> {
    const key = digestToken(token).toString("hex");
    const entry = this.#entries.get(key) ?? this.#retired.get(key);
    if (entry === undefined) return;
    await Promise.allSettled([...entry.calls.values()].map((call) => call.result));
    if (!this.#entries.has(key)) this.#retired.delete(key);
  }

  revoke(token: string): boolean {
    if (typeof token !== "string" || token.length === 0 || token.length > 512) {
      return false;
    }
    const key = digestToken(token).toString("hex");
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.#delete(key, entry);
    return true;
  }

  revokeIdentity(identity: ExecutionIdentity): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      const current = entry.scope.identity;
      if (
        current.runId === identity.runId &&
        current.path === identity.path &&
        current.attempt === identity.attempt &&
        current.generation === identity.generation
      ) {
        this.#delete(key, entry);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    for (const [key, entry] of this.#entries) {
      this.#delete(key, entry);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  #delete(key: string, entry: TokenEntry): void {
    this.#entries.delete(key);
    entry.abort.abort();
    if (entry.calls.size > 0) {
      this.#retired.set(key, entry);
      void Promise.allSettled([...entry.calls.values()].map((call) => call.result)).then(() =>
        this.#retired.delete(key),
      );
    }
    entry.release?.();
  }
}

export function scopeKey(scope: ExecScope): string {
  const { runId, path, attempt, generation } = scope.identity;
  return `${runId}\u0000${path}\u0000${attempt}\u0000${generation}`;
}
