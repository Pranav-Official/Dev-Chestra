import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExecutionIdentity } from "@devchestra/core";
import type { AgentContext } from "@devchestra/schema";

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
  /** Frozen per-node context-pool access; the model can never escalate it. */
  context: AgentContext;
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

function cloneScope(scope: ExecScope): ExecScope {
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
    context: { ...scope.context },
  });
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
  const context = scope.context as Partial<AgentContext> | undefined;
  if (
    context === undefined ||
    (context.project !== "none" && context.project !== "read") ||
    (context.workflow !== "none" && context.workflow !== "read") ||
    (context.execution !== "none" &&
      context.execution !== "read" &&
      context.execution !== "readwrite")
  ) {
    throw new Error("ExecScope context must be a valid AgentContext.");
  }
  if (!Number.isFinite(scope.expiresAt) || scope.expiresAt <= now) {
    throw new Error("ExecScope expiresAt must be a finite future timestamp.");
  }
}

/**
 * In-memory exec-token registry. Only sha256(token) is retained, never the
 * bearer value. Tokens are bound to a frozen, server-owned execution identity;
 * a model can never choose run/path/attempt/generation through a tool call.
 */
export class ExecTokenRegistry {
  readonly #entries = new Map<string, TokenEntry>();
  readonly #registerSecret: ExecTokenRegistryOptions["registerSecret"];

  constructor(options: ExecTokenRegistryOptions = {}) {
    this.#registerSecret = options.registerSecret;
  }

  issue(scope: ExecScope, now: number = Date.now()): string {
    validateScope(scope, now);
    const frozen = cloneScope(scope);
    const token = randomBytes(32).toString("base64url");
    const release = this.#registerSecret?.(token, "exec-token");
    const entry: TokenEntry = { digest: digestToken(token), scope: frozen };
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
    entry.release?.();
  }
}

export function scopeKey(scope: ExecScope): string {
  const { runId, path, attempt, generation } = scope.identity;
  return `${runId}\u0000${path}\u0000${attempt}\u0000${generation}`;
}
