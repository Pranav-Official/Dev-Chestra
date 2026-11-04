import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExecutionIdentity } from "@devchestra/core";
import type { ShellPolicy } from "@devchestra/schema";
import { DevChestraError } from "./errors.js";
import type { ExecOutcome } from "./shell-exec.js";

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

export interface ExecTokenRegistryOptions {
  /**
   * Optional persistence-sink hook. The composition root registers the bearer
   * with the store's secret guard and receives a release callback. The token
   * value itself is never retained by the registry.
   */
  registerSecret?: (token: string, name?: string) => (() => void) | undefined;
}

interface TokenEntry {
  digest: Buffer;
  scope: ExecScope;
  release?: () => void;
  abort: AbortController;
  calls: Map<string, { command: string; result: Promise<ExecOutcome> }>;
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

  constructor(options: ExecTokenRegistryOptions = {}) {
    this.#registerSecret = options.registerSecret;
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

  /** Join duplicate calls for this token; never repeat a side effect on transport retry. */
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
    const existing = entry.calls.get(callId);
    if (existing !== undefined) {
      if (existing.command !== command)
        throw new DevChestraError(
          "E_CONFLICT",
          "Call ID was already used with different arguments.",
        );
      return existing.result;
    }
    if (entry.calls.size >= 1000)
      throw new DevChestraError("E_FORBIDDEN", "Execution call limit reached.");
    const result = Promise.resolve().then(() => run(entry.abort.signal));
    entry.calls.set(callId, { command, result });
    return result;
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
