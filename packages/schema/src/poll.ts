import { DevChestraError, err, ok, type Result } from "@devchestra/core";
import { validateParams } from "./params.js";
import {
  type Issue,
  type JsonSchemaObject,
  type NormalizedStartNode,
  PROD_CLIS,
  type StartNode,
  type WorkflowParam,
} from "./types.js";
import { timeoutBounds } from "./validate-support.js";

/**
 * Polling probes. The probe is config inside the start node (`start.polling`),
 * not a graph node. An armed poller runs the probe on a timer; the probe
 * returns nothing, or the start parameters that should start a run.
 */

/** Max agent probe prompt size in UTF-8 bytes. Mirrors the engine CLI limit. */
export const POLL_AGENT_PROMPT_MAX_BYTES = 1024 * 1024;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface PollStartLike {
  id?: string;
  params: readonly WorkflowParam[];
  polling?: {
    enabled?: unknown;
    probe?: unknown;
    dedupe?: unknown;
    workspace?: unknown;
  };
}

/**
 * Semantic checks for a start node's polling block. Parse (strict Zod
 * objects) already rejects unknown keys; this reports field-level problems
 * against the saved file. All errors use E_POLL_PROBE so trigger layers can
 * tell a bad probe from other workflow problems.
 */
export function validatePollingConfig(start: PollStartLike, pointerBase: string): Issue[] {
  const issues: Issue[] = [];
  const polling = start.polling;
  if (polling === undefined) return [];
  const nodeId = start.id;
  const add = (
    severity: Issue["severity"],
    code: string,
    message: string,
    pointer: string,
  ): void => {
    issues.push({
      severity,
      code,
      message,
      pointer,
      ...(nodeId === undefined ? {} : { nodeId }),
    });
  };
  const fail = (code: string, message: string, pointer: string): void =>
    add("error", code, message, pointer);

  if (!isRecord(polling)) {
    fail("E_POLL_PROBE", "Start polling must be an object.", pointerBase);
    return issues;
  }
  if (typeof polling.enabled !== "boolean") {
    fail("E_POLL_PROBE", "Start polling.enabled must be a boolean.", `${pointerBase}/enabled`);
  }
  const probe = polling.probe;
  if (!isRecord(probe)) {
    fail("E_POLL_PROBE", "Start polling.probe must be an object.", `${pointerBase}/probe`);
  } else if (probe.type === "shell") {
    const command = (probe as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") {
      fail(
        "E_POLL_PROBE",
        "Poll shell probe command must be a non-empty string.",
        `${pointerBase}/probe/command`,
      );
    }
    const timeout = timeoutBounds(
      (probe as { timeoutMin?: number }).timeoutMin,
      "probe.timeoutMin",
    );
    if (timeout !== undefined) {
      fail("E_POLL_PROBE", timeout, `${pointerBase}/probe/timeoutMin`);
    }
  } else if (probe.type === "agent") {
    const typed = probe as {
      cli?: unknown;
      model?: unknown;
      prompt?: unknown;
      timeoutMin?: number;
    };
    const prodClis: readonly string[] = PROD_CLIS;
    if (typeof typed.cli !== "string" || !prodClis.includes(typed.cli)) {
      if (typed.cli === "fake") {
        add(
          "warning",
          "W_FAKE_CLI",
          "Poll agent probe CLI 'fake' is test-only (requires DEVCHESTRA_ALLOW_FAKE=1 at run time); do not use it for a real poller.",
          `${pointerBase}/probe/cli`,
        );
      } else {
        fail(
          "E_POLL_PROBE",
          `Poll agent probe CLI '${String(typed.cli)}' is not supported; use ${PROD_CLIS.join(", ")}.`,
          `${pointerBase}/probe/cli`,
        );
      }
    }
    if (typed.model !== undefined) {
      if (typeof typed.model !== "string" || typed.model.trim() === "") {
        fail(
          "E_POLL_PROBE",
          "Poll agent probe model must be a non-empty string.",
          `${pointerBase}/probe/model`,
        );
      }
    }
    if (typeof typed.prompt !== "string" || typed.prompt.trim() === "") {
      fail(
        "E_POLL_PROBE",
        "Poll agent probe prompt must be a non-empty string.",
        `${pointerBase}/probe/prompt`,
      );
    } else if (utf8Bytes(typed.prompt) > POLL_AGENT_PROMPT_MAX_BYTES) {
      fail(
        "E_POLL_PROBE",
        `Poll agent probe prompt exceeds the ${POLL_AGENT_PROMPT_MAX_BYTES}-byte limit.`,
        `${pointerBase}/probe/prompt`,
      );
    }
    const timeout = timeoutBounds(typed.timeoutMin, "probe.timeoutMin");
    if (timeout !== undefined) {
      fail("E_POLL_PROBE", timeout, `${pointerBase}/probe/timeoutMin`);
    }
  } else {
    fail(
      "E_POLL_PROBE",
      "Start polling.probe.type must be 'shell' or 'agent'.",
      `${pointerBase}/probe/type`,
    );
  }
  if (polling.dedupe !== undefined && typeof polling.dedupe !== "boolean") {
    fail("E_POLL_PROBE", "Start polling.dedupe must be a boolean.", `${pointerBase}/dedupe`);
  }
  if (
    polling.workspace !== undefined &&
    polling.workspace !== "project" &&
    polling.workspace !== "worktree"
  ) {
    fail(
      "E_POLL_PROBE",
      "Start polling.workspace must be 'project' or 'worktree'.",
      `${pointerBase}/workspace`,
    );
  }
  return issues;
}

export type PollShellProbeOutput = { kind: "shell"; stdout: string; exitCode: number };
export type PollAgentProbeOutput = { kind: "agent"; output: unknown };
export type PollProbeOutput = PollShellProbeOutput | PollAgentProbeOutput;

export type PollResult =
  | { found: false }
  | { found: true; params: Record<string, unknown>; dedupeKey?: string };

const NOTHING: PollResult = { found: false };

function pollFail(
  message: string,
  details?: Record<string, unknown>,
): Result<PollResult, DevChestraError> {
  return err(new DevChestraError("E_POLL_PROBE", message, { details }));
}

function checkedParams(
  start: StartNode | NormalizedStartNode,
  raw: Record<string, unknown>,
  dedupeKey: string | undefined,
): Result<PollResult, DevChestraError> {
  const validated = validateParams(start, raw);
  if (!validated.ok) {
    const first = validated.errors[0];
    return pollFail(
      `Poll probe returned invalid parameters: ${first?.message ?? "unknown error"}`,
      {
        issues: validated.errors,
      },
    );
  }
  return ok(
    dedupeKey === undefined
      ? { found: true as const, params: validated.value }
      : { found: true as const, params: validated.value, dedupeKey },
  );
}

function takeDedupeKey(raw: Record<string, unknown>): string | undefined {
  const key = raw.dedupeKey;
  delete raw.dedupeKey;
  return typeof key === "string" && key !== "" ? key : undefined;
}

function resolveShellResult(
  start: StartNode | NormalizedStartNode,
  stdout: string,
  exitCode: number,
): Result<PollResult, DevChestraError> {
  if (!Number.isSafeInteger(exitCode) || exitCode !== 0) {
    return pollFail(`Poll shell probe failed with exit code ${String(exitCode)}.`, {
      exitCode,
    });
  }
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") return ok(NOTHING);
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    isJson = false;
  }
  if (isJson) {
    if (parsed === null) return ok(NOTHING);
    if (isRecord(parsed)) {
      if ((parsed as Record<string, unknown>).found === false) return ok(NOTHING);
      const raw: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      const dedupeKey = takeDedupeKey(raw);
      if (Object.keys(raw).length === 0) return ok(NOTHING);
      return checkedParams(start, raw, dedupeKey);
    }
    if (typeof parsed === "string") {
      return resolveBareLine(start, parsed);
    }
    return resolveBareLine(start, trimmed);
  }
  return resolveBareLine(start, trimmed);
}

function resolveBareLine(
  start: StartNode | NormalizedStartNode,
  line: string,
): Result<PollResult, DevChestraError> {
  if (start.params.length !== 1) {
    return pollFail(
      "Poll shell probe output is not a JSON object; a bare value is only accepted when the start node declares exactly one parameter.",
    );
  }
  const only = start.params[0];
  if (only === undefined) return pollFail("Poll shell probe output could not be resolved.");
  // A bare scalar still passes through JSON first so `42` and `true` keep
  // their types for number/boolean parameters; anything else stays a string.
  let value: unknown = line;
  try {
    const scalar: unknown = JSON.parse(line);
    if (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") {
      value = scalar;
    }
  } catch {
    // Not JSON: the whole trimmed line is the value.
  }
  return checkedParams(start, { [only.name]: value }, undefined);
}

function resolveAgentResult(
  start: StartNode | NormalizedStartNode,
  output: unknown,
): Result<PollResult, DevChestraError> {
  if (!isRecord(output)) {
    return pollFail("Poll agent probe output must be a JSON object.");
  }
  if (output.found === false) return ok(NOTHING);
  if (output.found !== true) {
    return pollFail("Poll agent probe output must include found: boolean.");
  }
  const params = output.params;
  if (!isRecord(params)) {
    return pollFail("Poll agent probe output must include a params object.");
  }
  const raw: Record<string, unknown> = { ...params };
  const dedupeKey =
    typeof output.dedupeKey === "string" && output.dedupeKey !== "" ? output.dedupeKey : undefined;
  return checkedParams(start, raw, dedupeKey);
}

/**
 * Implements the probe output contract shared by both probe kinds. Both yield
 * the same poll result: nothing, or `{ params, dedupeKey? }`. Params go
 * through validateParams exactly like a manual run; a validation failure is a
 * probe failure (E_POLL_PROBE), never "nothing".
 */
export function resolvePollResult(
  start: StartNode | NormalizedStartNode,
  raw: PollProbeOutput,
): Result<PollResult, DevChestraError> {
  if (raw.kind === "shell") return resolveShellResult(start, raw.stdout, raw.exitCode);
  return resolveAgentResult(start, raw.output);
}

function pollParamSchema(param: WorkflowParam): JsonSchemaObject {
  if (param.type === "enum") {
    return { type: "string", enum: [...(param.options ?? [])] };
  }
  return { type: param.type };
}

/**
 * Builds the generated output schema for an agent probe from the start
 * params. The schema is generated, never user-set: every start param appears
 * as an optional property of `params`, plus `found` and `dedupeKey`.
 */
export function buildPollAgentOutputSchema(
  start: StartNode | NormalizedStartNode | { params: readonly WorkflowParam[] },
): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  for (const param of start.params) {
    properties[param.name] = pollParamSchema(param);
  }
  return {
    type: "object",
    properties: {
      found: { type: "boolean" },
      params: { type: "object", properties, additionalProperties: false },
      dedupeKey: { type: "string" },
    },
    required: ["found", "params"],
    additionalProperties: false,
  };
}

/**
 * Builds the short generated preamble for an agent probe prompt. It describes
 * the output contract and lists the start params the probe may return.
 */
export function buildPollPromptPreamble(
  start: StartNode | NormalizedStartNode | { params: readonly WorkflowParam[] },
): string {
  const lines = [
    "You are a read-only polling probe. Inspect the current state and decide whether a workflow run should start. You may run shell commands such as `gh` and `git` to look, but never change files, branches or remote state.",
    "Respond with a JSON object: { found: boolean, params: { ... }, dedupeKey?: string }.",
    "Set found to false when there is nothing to act on; params holds the workflow start parameters when found is true.",
    "Every params property is optional; missing values fall back to defaults and required checks still apply.",
    "dedupeKey is optional: when present, a result with a recently seen key is skipped as a duplicate.",
    "Do not change anything; network reads are allowed but workspace and project writes are not.",
  ];
  if (start.params.length === 0) {
    lines.push("The workflow declares no start parameters.");
  } else {
    lines.push("Start parameters:");
    for (const param of start.params) {
      const required = param.required ? "required" : "optional";
      let detail = `${param.name} (${param.type}, ${required}`;
      if (param.type === "enum") detail += `, one of: ${(param.options ?? []).join(", ")}`;
      if (param.default !== undefined) detail += `, default: ${JSON.stringify(param.default)}`;
      detail += ")";
      lines.push(`- ${detail}`);
    }
  }
  return lines.join("\n");
}
