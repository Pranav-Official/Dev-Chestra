import {
  type Actor,
  type ExecStatus,
  type JsonObject,
  type JsonValue,
  type NodeKind,
  type Path,
  parsePath,
  type RunCompletionStatus,
  type RunId,
  type RunKind,
  type RunPauseReason,
  type RunStatus,
} from "@relay/core";
import { WORKFLOW_ID_PATTERN } from "@relay/schema";
import { z } from "./zod.js";

/** Database/event identifiers are ULIDs (spec 3.1). */
const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const runIdSchema = z
  .string()
  .regex(RUN_ID_RE, "Run id must be a 26-character ULID")
  .transform((value) => value as RunId);

/** Project ids are slug-like; keep the bound but do not over-constrain test/local ids. */
export const projectIdSchema = z.string().min(1).max(128);
export const workflowIdSchema = z.string().min(1).max(64);

/** Managed workflow file ids (spec 5.1); stricter than URL/run workflow ids. */
export const workflowFileIdSchema = z
  .string()
  .regex(WORKFLOW_ID_PATTERN, "Workflow id must match ^[a-z0-9-]{1,64}$");

/**
 * A strong ETag validator without surrounding quotes, as carried in DTOs. The
 * HTTP header and If-Match use the quoted form (`quoteEtag`).
 */
const ETAG_VALUE = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/u;
export const etagSchema = z.string().regex(ETAG_VALUE, "ETag must be an unquoted strong validator");

export function quoteEtag(etag: string): string {
  return `"${etag}"`;
}

/** Parse an `ETag`/`If-Match` header; weak or malformed values return null. */
export function unquoteEtag(value: string | null): string | null {
  if (value === null || value.startsWith("W/")) return null;
  const match = /^"([^"]*)"$/u.exec(value);
  return match?.[1] === undefined ? null : match[1];
}

/** An execution path (spec 3.2); the empty string is the run-level path. */
export const pathSchema = z
  .string()
  .superRefine((value, ctx) => {
    const parsed = parsePath(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error.message });
    }
  })
  .transform((value) => value as Path);

export const nonEmptyPathSchema = pathSchema.refine((value) => value !== "", {
  message: "Execution path must not be empty",
});

export const epochMsSchema = z.number().int().nonnegative();
export const nullableEpochMsSchema = epochMsSchema.nullable();
export const eventIdSchema = z.number().int().nonnegative();

/**
 * Validate JSON without cloning it. Zod's `z.json()`/`z.record()` rebuild
 * objects, which silently drops an own `__proto__` key (the value is assigned
 * through the prototype setter). Payload schemas must return the original
 * object so arbitrary own keys survive API and event parsing.
 *
 * Traversal is iterative so deeply nested payloads cannot overflow the stack,
 * and an ancestry set only rejects true cycles (shared DAG references are
 * valid JSON). Accessor properties are rejected without invoking the getter.
 */
function isPlainJsonObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function isJsonStructure(value: unknown, requireObjectRoot: boolean): boolean {
  if (requireObjectRoot && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return false;
  }

  const stack: { value: unknown; exit: boolean }[] = [{ value, exit: false }];
  const ancestors = new Set<object>();

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.exit) {
      ancestors.delete(frame.value as object);
      continue;
    }

    const current = frame.value;
    if (current === null) continue;

    switch (typeof current) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (Number.isFinite(current)) continue;
        return false;
      case "object":
        break;
      default:
        return false;
    }

    const object = current as object;
    if (ancestors.has(object)) return false;
    if (!Array.isArray(object) && !isPlainJsonObject(object)) return false;

    ancestors.add(object);
    stack.push({ value: object, exit: true });

    if (Array.isArray(object)) {
      for (let index = object.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return false;
        stack.push({ value: descriptor.value, exit: false });
      }
      continue;
    }

    const keys = Object.keys(object);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      stack.push({ value: descriptor.value, exit: false });
    }
  }

  return true;
}

export const jsonValueSchema = z.custom<JsonValue>((value) => isJsonStructure(value, false), {
  message: "Expected a JSON value",
});
export const jsonObjectSchema = z.custom<JsonObject>((value) => isJsonStructure(value, true), {
  message: "Expected a JSON object",
});

const RUN_STATUS_VALUES = [
  "queued",
  "running",
  "paused",
  "waiting_approval",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
] as const satisfies readonly RunStatus[];

const EXEC_STATUS_VALUES = [
  "pending",
  "ready",
  "running",
  "validating",
  "waiting_approval",
  "waiting_quota",
  "succeeded",
  "failed",
  "skipped",
  "rejected",
  "cancelled",
  "interrupted",
] as const satisfies readonly ExecStatus[];

const NODE_KIND_VALUES = [
  "start",
  "agent",
  "shell",
  "end",
  "gate",
  "join",
  "approval",
  "decision",
  "map",
  "loop",
  "supervisor",
] as const satisfies readonly NodeKind[];

const RUN_PAUSE_REASON_VALUES = [
  "quota",
  "budget",
  "user",
  "approval_cap",
  "shutdown",
  "uncertain_side_effect",
] as const satisfies readonly RunPauseReason[];

const RUN_COMPLETION_STATUS_VALUES = [
  "success",
  "failed",
  "rejected",
  "cancelled",
] as const satisfies readonly RunCompletionStatus[];
const RUN_KIND_VALUES = ["run", "node_test"] as const satisfies readonly RunKind[];
const ACTOR_VALUES = [
  "engine",
  "scheduler",
  "user",
  "supervisor",
  "agent",
  "system",
] as const satisfies readonly Actor[];

export const runStatusSchema = z.enum(RUN_STATUS_VALUES);
export const execStatusSchema = z.enum(EXEC_STATUS_VALUES);
export const nodeKindSchema = z.enum(NODE_KIND_VALUES);
export const runPauseReasonSchema = z.enum(RUN_PAUSE_REASON_VALUES);
export const runCompletionStatusSchema = z.enum(RUN_COMPLETION_STATUS_VALUES);
export const runKindSchema = z.enum(RUN_KIND_VALUES);
export const actorSchema = z.enum(ACTOR_VALUES);

/** Pagination contract used by every list endpoint. */
export interface ListResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export function listResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.strictObject({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });
}

export const cursorQuerySchema = z.string().min(1).optional();
export const limitQuerySchema = z.coerce.number().int().min(1).max(500).optional();

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Build a same-origin API URL with every path segment encoded exactly once. */
export function apiPath(...segments: readonly string[]): string {
  const suffix = segments.map(encodePathSegment).join("/");
  return suffix.length === 0 ? "/api" : `/api/${suffix}`;
}
