import type { JsonValue } from "./events.js";
import type { Path } from "./path.js";
import type { RunId } from "./ids.js";

/**
 * Reference-backed execution context (Part A).
 *
 * A loop-parent capture is immutable and scoped to ONE workflow run. Node
 * outputs are stored once in the existing durable `outputs` table; a capture
 * manifest references exact accepted output IDs instead of copying values.
 * Resume resolves the SAME outputs even if later attempts exist.
 *
 * Design principles enforced here:
 * - Execution context is scoped to one run (runId is part of every ref).
 * - Reuse durable output storage; never copy full outputs into events.
 * - Reducers stay pure: this module does no storage I/O, only tagging.
 * - Explicitly tagged/versioned representation (`kind` discriminator).
 */

export const EXECUTION_CONTEXT_KIND = "devchestra.execution-context/v1" as const;
export const EXECUTION_CONTEXT_VERSION = 1 as const;

/** Compact reference placed in the loop-start event (small, bounded). */
export interface ExecutionContextRef {
  kind: typeof EXECUTION_CONTEXT_KIND;
  /** Durable capture row id (deterministic hash of the manifest). */
  captureId: string;
}

export type CaptureEntryKind = "run-params" | "output" | "literal";

export interface RunParamsCaptureEntry {
  /** Scope key, e.g. "start". */
  name: string;
  type: "run-params";
}

export interface OutputCaptureEntry {
  /** Scope key, e.g. node id. */
  name: string;
  type: "output";
  /** Exact accepted output row id (unique per run/path/attempt). */
  outputId: string;
  /** Provenance for verification; must match the output row. */
  path: string;
  attempt: number;
  /** Node kind at capture time, for compatibility adapters (e.g. decision). */
  nodeKind: string | null;
  /** Output hash at capture time, for corruption detection. */
  hash: string;
}

export interface LiteralCaptureEntry {
  /** Scope key, e.g. node id for skipped/failed ancestors (null). */
  name: string;
  type: "literal";
  /** Small JSON value only (null/unavailable markers, never full outputs). */
  value: JsonValue;
}

export type CaptureEntry = RunParamsCaptureEntry | OutputCaptureEntry | LiteralCaptureEntry;

export interface ExecutionContextManifest {
  version: typeof EXECUTION_CONTEXT_VERSION;
  runId: RunId;
  /** Loop controller path that owns this capture. */
  loopPath: Path;
  entries: CaptureEntry[];
}

/** Per-literal JSON cap; literals are unavailable/null markers, never bulk data. */
export const CAPTURE_LITERAL_MAX_BYTES = 16 * 1024;
/** Manifest storage cap (separate from event payload caps). Documents the bound. */
export const CAPTURE_MANIFEST_MAX_BYTES = 1024 * 1024;

export function isExecutionContextRef(value: unknown): value is ExecutionContextRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === EXECUTION_CONTEXT_KIND && typeof record.captureId === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCaptureEntry(value: unknown): string | null {
  if (!isPlainObject(value)) return "capture entry must be an object";
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 256) {
    return "capture entry name must be a non-empty string";
  }
  if (value.type === "run-params") return null;
  if (value.type === "output") {
    if (typeof value.outputId !== "string" || value.outputId.length === 0) {
      return "output entry outputId must be a non-empty string";
    }
    if (typeof value.path !== "string" || value.path.length === 0) return "output entry path invalid";
    if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
      return "output entry attempt must be a positive integer";
    }
    if (typeof value.hash !== "string" || value.hash.length === 0) return "output entry hash invalid";
    if (value.nodeKind !== null && typeof value.nodeKind !== "string") {
      return "output entry nodeKind must be string or null";
    }
    return null;
  }
  if (value.type === "literal") {
    if (!("value" in value)) return "literal entry must carry a value";
    return null;
  }
  return "capture entry type must be run-params, output, or literal";
}

export function validateManifest(value: unknown): string | null {
  if (!isPlainObject(value)) return "capture manifest must be an object";
  if (value.version !== EXECUTION_CONTEXT_VERSION) return "unsupported capture version";
  if (typeof value.runId !== "string" || typeof value.loopPath !== "string") {
    return "capture manifest runId/loopPath invalid";
  }
  if (!Array.isArray(value.entries)) return "capture manifest entries must be an array";
  if (value.entries.length > 1000) return "capture manifest has too many entries";
  const names = new Set<string>();
  for (const entry of value.entries) {
    const issue = validateCaptureEntry(entry);
    if (issue !== null) return issue;
    const name = (entry as CaptureEntry).name;
    if (names.has(name)) return `duplicate capture entry '${name}'`;
    names.add(name);
  }
  return null;
}


