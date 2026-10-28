import { isRecord } from "@devchestra/core";
import { boundCount, boundMs, hasControl, printable } from "./discovery-util.js";
import type { ClaudeModelDiscovery, ClaudeModelDiscoveryStatus, ClaudeModelItem } from "./types.js";

const ID_MAX = 256;
const LABEL_MAX = 256;
const DESCRIPTION_MAX = 1024;
const PROVIDER_MAX = 128;
const ALIAS_MAX = 256;
const ALIASES_MAX = 32;
const VERSION_MAX = 64;
const MODELS_MAX = 1000;
const DEFAULT_GRACE_MS = 1_000;
const TOTAL_MAX_MS = 15_000;
const STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 64 * 1024;

export type ClaudeFailureReason =
  | "invalid"
  | "missing"
  | "unsupported"
  | "unavailable"
  | "protocol"
  | "oversize"
  | "timeout"
  | "cancelled"
  | "closed"
  | "auth"
  | "blocked"
  | "stop";

export const CLAUDE_MESSAGES = {
  invalid: "Invalid model discovery request.",
  missing: "Claude Code executable was not found.",
  unsupported: "This Claude Code version does not report a model catalog.",
  unavailable: "Claude model discovery is unavailable.",
  protocol: "Claude Code returned an invalid initialization response.",
  oversize: "Claude Code output exceeded safe limits.",
  timeout: "Claude model discovery timed out.",
  cancelled: "Claude model discovery was cancelled.",
  closed: "Claude Code closed the connection unexpectedly.",
  auth: "Claude requires authentication to list models.",
  blocked: "Claude Code attempted an unexpected prompt or tool request.",
  stop: "Claude model discovery could not stop its process.",
} as const;

export interface ClaudeLimits {
  totalMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxModels: number;
  graceMs: number;
}

export class ClaudeNormalizeError extends Error {
  readonly reason: "protocol" | "unsupported";

  constructor(reason: "protocol" | "unsupported") {
    super(reason);
    this.name = "ClaudeNormalizeError";
    this.reason = reason;
  }
}

function statusFor(reason: ClaudeFailureReason): ClaudeModelDiscoveryStatus {
  if (reason === "unsupported") return "unsupported";
  if (reason === "auth") return "authRequired";
  return "unavailable";
}

export function claudeFailure(reason: ClaudeFailureReason): ClaudeModelDiscovery {
  return {
    status: statusFor(reason),
    items: [],
    cliVersion: null,
    truncated: false,
    message: CLAUDE_MESSAGES[reason],
  };
}

export function claudeLimits(request: {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxModels?: number;
  graceMs?: number;
}): ClaudeLimits {
  const totalMs = boundMs(request.timeoutMs, TOTAL_MAX_MS);
  return {
    totalMs,
    maxStdoutBytes: boundCount(request.maxStdoutBytes, STDOUT_MAX),
    maxStderrBytes: boundCount(request.maxStderrBytes, STDERR_MAX),
    maxModels: boundCount(request.maxModels, MODELS_MAX),
    graceMs: boundMs(request.graceMs, DEFAULT_GRACE_MS),
  };
}

function capped(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function parseVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = printable(value);
  if (cleaned === "" || cleaned.length > VERSION_MAX) return null;
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(cleaned) ? cleaned : null;
}

function stringList(value: unknown, max: number, eachMax: number): string[] {
  const out: string[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "string") continue;
    const cleaned = capped(printable(raw), eachMax);
    if (cleaned === "" || out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length === max) break;
  }
  return out;
}

function parseItem(row: Record<string, unknown>): ClaudeModelItem | null {
  const value = row.value;
  if (typeof value !== "string" || value === "" || value.length > ID_MAX) return null;
  if (hasControl(value)) return null;

  const display = typeof row.displayName === "string" ? printable(row.displayName) : "";
  const label = display === "" ? value : capped(display, LABEL_MAX);
  const item: ClaudeModelItem = { id: value, label, source: "claude-sdk" };

  if (typeof row.description === "string") {
    const description = capped(printable(row.description), DESCRIPTION_MAX);
    if (description !== "") item.description = description;
  }
  if (typeof row.provider === "string") {
    const provider = capped(printable(row.provider), PROVIDER_MAX);
    if (provider !== "") item.provider = provider;
  }
  if (Array.isArray(row.aliases)) {
    const aliases = stringList(row.aliases, ALIASES_MAX, ALIAS_MAX);
    if (aliases.length > 0) item.aliases = aliases;
  }
  if (typeof row.isDefault === "boolean") item.isDefault = row.isDefault;
  return item;
}

export interface NormalizedInitialization {
  items: ClaudeModelItem[];
  cliVersion: string | null;
  truncated: boolean;
}

/**
 * Read only the initialize metadata. `ModelInfo.value` stays the id; a
 * `resolvedModel` is never substituted for it and never becomes an alias.
 */
export function normalizeInitialization(
  value: unknown,
  maxModels: number,
): NormalizedInitialization {
  if (!isRecord(value)) throw new ClaudeNormalizeError("protocol");
  if (!("models" in value) || value.models === undefined) {
    throw new ClaudeNormalizeError("unsupported");
  }
  if (!Array.isArray(value.models)) throw new ClaudeNormalizeError("protocol");

  const rawModels = value.models;
  const limit = Math.min(rawModels.length, maxModels);
  const items: ClaudeModelItem[] = [];
  const seen = new Set<string>();
  let truncated = rawModels.length > maxModels;

  for (let index = 0; index < limit; index += 1) {
    const row = rawModels[index];
    if (!isRecord(row)) {
      truncated = true;
      continue;
    }
    const item = parseItem(row);
    if (item === null) {
      truncated = true;
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  return { items, cliVersion: parseVersion(value.claude_code_version), truncated };
}

const AUTH_RE =
  /auth|login|log in|sign in|signin|unauthori[sz]ed|credential|api.?key|not logged|oauth/i;
const UNSUPPORTED_RE =
  /compatib|unsupported|not support|unknown (?:option|flag|argument|method|field)|invalid (?:option|flag|argument)|requires|minimum|too old|version/i;
const TIMEOUT_RE = /timed? ?out|timeout/i;
const OVERSIZE_RE = /too (?:large|much)|exceeded|max(?:imum)? (?:size|bytes|limit)|buffer.*limit/i;
const CLOSED_RE =
  /closed|exit(?:ed)? (?:with|unexpectedly)|process exited|connection (?:closed|lost)/i;

export function classifyClaudeError(error: unknown): ClaudeModelDiscovery {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();
  if (AUTH_RE.test(text)) return claudeFailure("auth");
  if (UNSUPPORTED_RE.test(text)) return claudeFailure("unsupported");
  if (CLOSED_RE.test(text)) return claudeFailure("closed");
  if (TIMEOUT_RE.test(text)) return claudeFailure("timeout");
  if (OVERSIZE_RE.test(text)) return claudeFailure("oversize");
  return claudeFailure("unavailable");
}
