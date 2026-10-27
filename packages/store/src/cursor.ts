import { hashJsonSync } from "./hash.js";
import { fail } from "./util.js";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;

export function pageLimit(value: number | undefined, fallback = DEFAULT_PAGE_LIMIT): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) fail("E_VALIDATION", "limit must be a safe integer");
  return Math.min(Math.max(value, 1), MAX_PAGE_LIMIT);
}

export function queryFingerprint(value: unknown): string {
  return hashJsonSync(value);
}

/** Escape a literal path prefix for `LIKE ? ESCAPE '\'`. */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface RunsCursor {
  v: 1;
  k: "runs";
  q: string;
  c: number;
  i: string;
}

export interface EventsCursor {
  v: 1;
  k: "events";
  q: string;
  r: string;
  a: number;
  u: number | null;
}

export interface OutputsCursor {
  v: 1;
  k: "outputs";
  q: string;
  c: number;
  i: string;
}

type Cursor = RunsCursor | EventsCursor | OutputsCursor;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(row: Record<string, unknown>, name: string, max: number): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("E_VALIDATION", `Malformed cursor: ${name} is invalid`);
  }
  return value;
}

function requireInteger(row: Record<string, unknown>, name: string, minimum: number): number {
  const value = row[name];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("E_VALIDATION", `Malformed cursor: ${name} is invalid`);
  }
  return value as number;
}

function decode(cursor: string): Record<string, unknown> {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096) {
    fail("E_VALIDATION", "Malformed cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    fail("E_VALIDATION", "Malformed cursor");
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.k !== "string") {
    fail("E_VALIDATION", "Malformed cursor");
  }
  if (typeof parsed.q !== "string" || parsed.q.length === 0) {
    fail("E_VALIDATION", "Malformed cursor: query fingerprint is missing");
  }
  return parsed;
}

function requireKind(row: Record<string, unknown>, kind: Cursor["k"]): void {
  if (row.k !== kind) {
    fail("E_VALIDATION", `Cursor does not belong to a ${kind} page`);
  }
}

export function decodeRunsCursor(cursor: string): RunsCursor {
  const row = decode(cursor);
  requireKind(row, "runs");
  return {
    v: 1,
    k: "runs",
    q: row.q as string,
    c: requireInteger(row, "c", 0),
    i: requireString(row, "i", 256),
  };
}

export function decodeEventsCursor(cursor: string): EventsCursor {
  const row = decode(cursor);
  requireKind(row, "events");
  const upTo = row.u;
  if (
    upTo !== null &&
    upTo !== undefined &&
    (typeof upTo !== "number" || !Number.isSafeInteger(upTo) || upTo < 0)
  ) {
    fail("E_VALIDATION", "Malformed cursor: u is invalid");
  }
  return {
    v: 1,
    k: "events",
    q: row.q as string,
    r: requireString(row, "r", 256),
    a: requireInteger(row, "a", 0),
    u: upTo === undefined ? null : (upTo as number | null),
  };
}

export function decodeOutputsCursor(cursor: string): OutputsCursor {
  const row = decode(cursor);
  requireKind(row, "outputs");
  return {
    v: 1,
    k: "outputs",
    q: row.q as string,
    c: requireInteger(row, "c", 0),
    i: requireString(row, "i", 256),
  };
}
