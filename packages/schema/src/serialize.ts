import { DevChestraError, err, ok, type Result } from "@devchestra/core";
import { MAX_WORKFLOW_FILE_BYTES, WORKFLOW_ID_PATTERN } from "./ids.js";
import { parseWorkflow } from "./parse.js";
import type { WorkflowFile } from "./types.js";

const KEY_PRIORITY: Readonly<Record<string, number>> = { id: 0, type: 1, name: 2 };
const OTHER_PRIORITY = 3;

function pointer(path: readonly string[]): string {
  if (path.length === 0) return "";
  return `/${path.map((part) => part.replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
}

function invalid(message: string, path: readonly string[]): DevChestraError {
  return new DevChestraError("E_WORKFLOW_INVALID", message, {
    details: { pointer: pointer(path) },
  });
}

function compareKeys(left: string, right: string): number {
  const leftPriority = KEY_PRIORITY[left] ?? OTHER_PRIORITY;
  const rightPriority = KEY_PRIORITY[right] ?? OTHER_PRIORITY;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown, path: string[], seen: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw invalid("Workflow contains a non-finite number.", path);
      }
      return value;
    case "object":
      break;
    default:
      throw invalid(`Workflow contains a non-JSON ${typeof value} value.`, path);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw invalid("Workflow contains a cyclic array.", path);
    seen.add(value);
    const out = value.map((item, index) => stableValue(item, [...path, String(index)], seen));
    seen.delete(value);
    return out;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("Workflow contains a non-plain object.", path);
  }
  if (seen.has(value)) throw invalid("Workflow contains a cyclic object.", path);
  seen.add(value);

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort(compareKeys)) {
    // defineProperty keeps a data key named "__proto__" from mutating a prototype.
    Object.defineProperty(out, key, {
      value: stableValue(record[key], [...path, key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(value);
  return out;
}

/**
 * Canonical, browser-safe workflow file serializer: 2-space indent, trailing
 * newline, deterministic key order (id, type, name first, then lexicographic),
 * while preserving `ui` and graph/params array order. Rejects values JSON
 * cannot represent (non-finite numbers, undefined, bigint, functions, cycles,
 * non-plain objects) and enforces the 1 MiB file cap.
 */
export function serializeWorkflow(file: WorkflowFile): Result<string, DevChestraError> {
  const parsed = parseWorkflow(file);
  if (!parsed.ok) return err(parsed.error);
  if (!WORKFLOW_ID_PATTERN.test(parsed.value.id)) {
    return err(
      new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow id '${parsed.value.id}' must match ${WORKFLOW_ID_PATTERN.source}.`,
        { details: { pointer: "/id" } },
      ),
    );
  }

  let stable: unknown;
  try {
    stable = stableValue(parsed.value, [], new Set<object>());
  } catch (error) {
    return err(
      error instanceof DevChestraError
        ? error
        : new DevChestraError("E_WORKFLOW_INVALID", "Could not serialize the workflow", {
            cause: error,
          }),
    );
  }

  const text = `${JSON.stringify(stable, null, 2)}\n`;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_WORKFLOW_FILE_BYTES) {
    return err(
      new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow file exceeds the ${MAX_WORKFLOW_FILE_BYTES}-byte limit.`,
        { details: { bytes, maxBytes: MAX_WORKFLOW_FILE_BYTES } },
      ),
    );
  }
  return ok(text);
}
