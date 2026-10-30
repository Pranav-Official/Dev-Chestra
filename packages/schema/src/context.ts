import { DevChestraError, err, ok, type Result } from "@devchestra/core";
import {
  CONTEXT_KEY_PATTERN,
  CONTEXT_MAX_ENTRIES,
  CONTEXT_TOTAL_MAX_BYTES,
  CONTEXT_VALUE_MAX_BYTES,
  type ContextEntry,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate project context file contents (`.devchestra/context.json`): an
 * array of `{ key, value }` notes with the same caps as workflow `context`
 * entries. No I/O here; callers read the file and pass the parsed JSON.
 */
export function parseContextEntries(value: unknown): Result<ContextEntry[], DevChestraError> {
  if (!Array.isArray(value)) {
    return err(
      new DevChestraError("E_VALIDATION", "Project context must be an array of { key, value }."),
    );
  }
  if (value.length > CONTEXT_MAX_ENTRIES) {
    return err(
      new DevChestraError("E_VALIDATION", "Project context exceeds 64 entries.", {
        details: { count: value.length, limit: CONTEXT_MAX_ENTRIES },
      }),
    );
  }
  const seen = new Set<string>();
  const entries: ContextEntry[] = [];
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.value !== "string") {
      return err(
        new DevChestraError(
          "E_VALIDATION",
          `Project context entry ${index} must be { key, value } strings.`,
        ),
      );
    }
    if (!CONTEXT_KEY_PATTERN.test(item.key)) {
      return err(
        new DevChestraError(
          "E_VALIDATION",
          `Project context key '${item.key}' must match [A-Za-z0-9._-] (1-64 chars), starting alphanumeric.`,
        ),
      );
    }
    if (
      item.value.length === 0 ||
      Buffer.byteLength(item.value, "utf8") > CONTEXT_VALUE_MAX_BYTES
    ) {
      return err(
        new DevChestraError(
          "E_VALIDATION",
          `Project context value for '${item.key}' must be 1-4096 bytes.`,
        ),
      );
    }
    if (seen.has(item.key)) {
      return err(
        new DevChestraError("E_VALIDATION", `Duplicate project context key '${item.key}'.`),
      );
    }
    seen.add(item.key);
    total += Buffer.byteLength(item.value, "utf8");
    entries.push({ key: item.key, value: item.value });
  }
  if (total > CONTEXT_TOTAL_MAX_BYTES) {
    return err(
      new DevChestraError("E_VALIDATION", "Project context entries exceed 32 KiB in total.", {
        details: { bytes: total, limit: CONTEXT_TOTAL_MAX_BYTES },
      }),
    );
  }
  return ok(entries);
}
