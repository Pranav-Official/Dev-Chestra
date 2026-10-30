import {
  CAPTURE_LITERAL_MAX_BYTES,
  CAPTURE_MANIFEST_MAX_BYTES,
  EXECUTION_CONTEXT_VERSION,
  isExecutionContextRef,
  validateManifest,
  type CaptureEntry,
  type ExecutionContextManifest,
  type ExecutionContextRef,
} from "@devchestra/core";
import { canonicalJson, type JsonObject } from "@devchestra/core";
import { hashJsonSync } from "./hash.js";
import { now, type Runtime } from "./runtime.js";
import type {
  ContextCaptureRecord,
  CreateContextCaptureInput,
} from "./types.js";
import { fail, parseJson } from "./util.js";

interface CaptureRow {
  id: string;
  run_id: string;
  path: string;
  attempt: number;
  generation: number;
  bytes: number;
  json: string;
  created_at: number;
}

interface OutputRow {
  id: string;
  run_id: string;
  path: string;
  attempt: number;
  generation: number;
  kind: string;
  hash: string;
  bytes: number;
  json: string;
  created_at: number;
}

function requireRunMatches(runtime: Runtime, runId: string): void {
  const row = runtime.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
  if (!row) fail("E_NOT_FOUND", `Run ${runId} does not exist`);
}

export function deterministicCaptureId(manifest: ExecutionContextManifest): string {
  return `ctx_${hashJsonSync({
    v: manifest.version,
    runId: manifest.runId,
    loopPath: manifest.loopPath,
    entries: manifest.entries,
  }).slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve the scope adapter for decision nodes (null confidence reads as 0). */
function decisionScopeValue(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (output.confidence !== null || output.confidenceSource !== null) return output;
  if (typeof output.branch !== "string") return output;
  return { ...output, confidence: 0 };
}

function checkedLiteral(value: unknown, name: string): string {
  let text: string;
  try {
    text = canonicalJson(value);
  } catch (error) {
    fail("E_VALIDATION", `Capture literal '${name}' is not canonical JSON-serializable`, { cause: error });
  }
  if (Buffer.byteLength(text, "utf8") > CAPTURE_LITERAL_MAX_BYTES) {
    fail("E_VALIDATION", `Capture literal '${name}' exceeds its bound; literals cannot smuggle bulk output`, {
      bytes: Buffer.byteLength(text, "utf8"),
      limit: CAPTURE_LITERAL_MAX_BYTES,
    });
  }
  return text;
}

/**
 * Centralized reference verification. Every output reference is checked
 * against its durable row: run ownership, path, attempt, accepted-output kind,
 * and content identity recomputed with the project's canonical hashing
 * convention (never a bare stored-hash string comparison). Throws clearly;
 * never falls back to a "latest" output.
 */
export function verifyOutputReference(
  runtime: Runtime,
  runId: string,
  entry: Extract<CaptureEntry, { type: "output" }>,
): OutputRow {
  const row = runtime.db
    .prepare("SELECT * FROM outputs WHERE id = ?")
    .get(entry.outputId) as OutputRow | undefined;
  if (!row) {
    fail("E_NOT_FOUND", `Capture references missing output ${entry.outputId}`, {
      outputId: entry.outputId,
    });
  }
  const output = row as OutputRow;
  if (output.run_id !== runId) {
    fail("E_FORBIDDEN_PATH", "Cross-run output reference rejected", {
      outputId: entry.outputId,
    });
  }
  if (output.path !== entry.path || output.attempt !== entry.attempt) {
    fail("E_CONFLICT", `Capture reference path/attempt mismatch for ${entry.outputId}`, {
      outputId: entry.outputId,
      expected: { path: entry.path, attempt: entry.attempt },
      actual: { path: output.path, attempt: output.attempt },
    });
  }
  if (output.kind !== "output") {
    fail("E_CONFLICT", `Capture reference ${entry.outputId} is not an accepted output`, {
      outputId: entry.outputId,
      kind: output.kind,
    });
  }
  let recomputed: string;
  try {
    recomputed = hashJsonSync(parseJson(output.json));
  } catch (error) {
    fail("E_INTERNAL", `Captured output ${entry.outputId} is corrupt and cannot be verified`, {
      outputId: entry.outputId,
      cause: error,
    });
  }
  if (recomputed !== output.hash || output.hash !== entry.hash) {
    fail("E_CONFLICT", `Captured output ${entry.outputId} content changed; refusing latest-output fallback`, {
      outputId: entry.outputId,
    });
  }
  return output;
}

function verifyCaptureIntegrity(
  capture: ContextCaptureRecord,
  runId: string,
  loopPath?: string,
): ExecutionContextManifest {
  if ((capture.runId as string) !== runId) {
    fail("E_FORBIDDEN_PATH", "Cross-run context reference rejected", {
      captureId: capture.id,
    });
  }
  if (loopPath !== undefined && (capture.manifest.loopPath as string) !== loopPath) {
    fail("E_CONFLICT", "Capture belongs to a different loop controller", {
      captureId: capture.id,
      expected: loopPath,
      actual: capture.manifest.loopPath,
    });
  }
  const issue = validateManifest(capture.manifest);
  if (issue !== null) {
    fail("E_INTERNAL", `Stored capture manifest is invalid: ${issue}`, {
      captureId: capture.id,
    });
  }
  return capture.manifest;
}

export function createContextCapture(
  runtime: Runtime,
  input: CreateContextCaptureInput,
): ContextCaptureRecord {
  requireRunMatches(runtime, input.runId as string);
  const entries = input.entries as CaptureEntry[];
  const manifest: ExecutionContextManifest = {
    version: EXECUTION_CONTEXT_VERSION,
    runId: input.runId,
    loopPath: input.path,
    entries,
  };
  const issue = validateManifest(manifest);
  if (issue !== null) fail("E_VALIDATION", `Invalid execution-context capture: ${issue}`);
  const text = canonicalJson(manifest);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > CAPTURE_MANIFEST_MAX_BYTES) {
    fail("E_VALIDATION", "Execution-context capture exceeds its storage bound", {
      bytes,
      limit: CAPTURE_MANIFEST_MAX_BYTES,
    });
  }
  // Secret hygiene is authoritative at capture time: run params, literal values
  // and referenced outputs are scanned here (outputs were also scanned at
  // submission/record time). Values are immutable afterwards, so resolution
  // does not rescan; see resolveCaptureScope.
  const runRow = runtime.db
    .prepare("SELECT params_json FROM runs WHERE id = ?")
    .get(input.runId as string) as { params_json: string } | undefined;
  if (runRow) {
    const finding = runtime.secrets.scanValue(parseJson(runRow.params_json));
    if (finding) {
      fail("E_VALIDATION", "Loop parent contains a secret; remove it before starting", {
        path: finding.path,
        source: finding.source,
        label: finding.label,
      });
    }
  }
  for (const entry of entries) {
    if (entry.type === "literal") {
      checkedLiteral(entry.value, entry.name);
      const finding = runtime.secrets.scanValue(entry.value);
      if (finding) {
        fail("E_VALIDATION", "Loop parent contains a secret; remove it before starting", {
          path: finding.path,
          source: finding.source,
          label: finding.label,
        });
      }
    }
    if (entry.type === "output") {
      const output = verifyOutputReference(runtime, input.runId as string, entry);
      const finding = runtime.secrets.scanValue(parseJson(output.json));
      if (finding) {
        fail("E_VALIDATION", "Loop parent contains a secret; remove it before starting", {
          path: finding.path,
          source: finding.source,
          label: finding.label,
        });
      }
    }
  }

  const captureId = deterministicCaptureId(manifest);
  const existing = runtime.db
    .prepare("SELECT * FROM context_captures WHERE id = ?")
    .get(captureId) as CaptureRow | undefined;
  if (existing) {
    // Idempotent: same content reuses the same capture id.
    if (existing.run_id !== input.runId) {
      fail("E_CONFLICT", "Capture id collision across runs");
    }
    return mapCapture(existing);
  }
  const createdAt = now(runtime);
  runtime.db
    .prepare(
      `INSERT INTO context_captures (id, run_id, path, attempt, generation, bytes, json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      captureId,
      input.runId,
      input.path,
      input.identity.attempt,
      input.identity.generation,
      bytes,
      text,
      createdAt,
    );
  return {
    id: captureId,
    runId: input.runId,
    path: input.path,
    attempt: input.identity.attempt,
    generation: input.identity.generation,
    bytes,
    manifest,
    createdAt,
  };
}

function mapCapture(row: CaptureRow): ContextCaptureRecord {
  return {
    id: row.id,
    runId: row.run_id as ContextCaptureRecord["runId"],
    path: row.path as ContextCaptureRecord["path"],
    attempt: row.attempt,
    generation: row.generation,
    bytes: row.bytes,
    manifest: parseJson<ExecutionContextManifest>(row.json),
    createdAt: row.created_at,
  };
}

export function getContextCapture(
  runtime: Runtime,
  captureId: string,
): ContextCaptureRecord | null {
  if (typeof captureId !== "string" || captureId.length === 0 || captureId.length > 256) {
    fail("E_VALIDATION", "capture id must be a non-empty string");
  }
  const row = runtime.db.prepare("SELECT * FROM context_captures WHERE id = ?").get(captureId) as
    | CaptureRow
    | undefined;
  return row === undefined ? null : mapCapture(row);
}

export function requireContextCapture(
  runtime: Runtime,
  ref: ExecutionContextRef,
  runId: string,
  loopPath?: string,
): ContextCaptureRecord {
  if (!isExecutionContextRef(ref)) {
    fail("E_VALIDATION", "Loop parent reference must be a tagged execution-context reference");
  }
  const capture = getContextCapture(runtime, ref.captureId);
  if (!capture) {
    fail("E_NOT_FOUND", `Execution-context capture ${ref.captureId} is missing or corrupt`, {
      captureId: ref.captureId,
    });
  }
  const record = capture as ContextCaptureRecord;
  verifyCaptureIntegrity(record, runId, loopPath);
  return record;
}

/**
 * Resolve a capture to its hydrated parent scope. Verification is centralized
 * here: ownership, manifest integrity, and per-reference content identity are
 * rechecked on every resolution (no latest-output fallback). Secret policy:
 * values were scanned at capture time and are immutable afterwards, so no
 * rescan occurs here; the returned scope is a fresh object per call.
 */
export function resolveCaptureScope(
  runtime: Runtime,
  runId: string,
  captureId: string,
): Record<string, unknown> {
  const capture = getContextCapture(runtime, captureId);
  if (!capture) {
    fail("E_NOT_FOUND", `Execution-context capture ${captureId} is missing or corrupt`, {
      captureId,
    });
  }
  const manifest = verifyCaptureIntegrity(capture as ContextCaptureRecord, runId);
  const runRow = runtime.db
    .prepare("SELECT params_json FROM runs WHERE id = ?")
    .get(runId) as { params_json: string } | undefined;
  if (!runRow) fail("E_NOT_FOUND", `Run ${runId} does not exist`);
  const params = parseJson<JsonObject>(runRow.params_json);
  const scope: Record<string, unknown> = {};
  for (const entry of manifest.entries) {
    if (entry.type === "run-params") {
      scope[entry.name] = { ...params };
    } else if (entry.type === "literal") {
      scope[entry.name] = entry.value;
    } else {
      const output = verifyOutputReference(runtime, runId, entry);
      const value = entry.nodeKind === "decision" ? decisionScopeValue(parseJson(output.json)) : parseJson(output.json);
      scope[entry.name] = value;
    }
  }
  return scope;
}
