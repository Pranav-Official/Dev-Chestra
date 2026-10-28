import { isRecord } from "@relay/core";

const BIN_MAX = 4096;
const SEARCH_MAX = 256;

export function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function printable(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function boundMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(fallback, Math.max(1, Math.floor(value)));
}

export function boundCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(fallback, Math.max(1, Math.floor(value)));
}

export interface DiscoveryRequestFields {
  cwd: unknown;
  bin?: unknown;
  env: unknown;
  search?: unknown;
}

/**
 * Shared request validation for model discovery entry points: the
 * cwd/bin/env NUL and length checks plus the optional `search` checks. The
 * search check applies only when the field is present, so requests without
 * it (Codex, Opencode, Claude) validate exactly as before. A leading `-`
 * is rejected because search travels as a positional CLI argument and
 * could otherwise be parsed as a flag.
 */
export function validateDiscoveryRequest(request: DiscoveryRequestFields): boolean {
  if (typeof request.cwd !== "string" || request.cwd === "" || request.cwd.includes("\u0000")) {
    return false;
  }
  if (
    request.bin !== undefined &&
    (typeof request.bin !== "string" ||
      request.bin === "" ||
      request.bin.length > BIN_MAX ||
      request.bin.includes("\u0000"))
  ) {
    return false;
  }
  if (!isRecord(request.env)) return false;
  for (const [name, value] of Object.entries(request.env)) {
    if (name === "" || name.includes("=") || name.includes("\u0000")) return false;
    if (typeof value !== "string" || value.includes("\u0000")) return false;
  }
  if (
    request.search !== undefined &&
    (typeof request.search !== "string" ||
      request.search === "" ||
      request.search.length > SEARCH_MAX ||
      request.search.includes("\u0000") ||
      request.search.startsWith("-"))
  ) {
    return false;
  }
  return true;
}
