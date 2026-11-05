import { DevChestraError, err, ok, type Result } from "@devchestra/core";
import { validateParams } from "./params.js";
import { compileTemplate } from "./template.js";
import {
  type Issue,
  isModelTierId,
  type JsonSchemaObject,
  MCP_SCOPES,
  MODEL_TIERS,
  type NormalizedStartNode,
  POLL_PROBE_ID,
  type PollProbe,
  PROD_CLIS,
  type StartNode,
  type ValidationContext,
  type WorkflowParam,
} from "./types.js";
import { retryBounds, timeoutBounds } from "./validate-support.js";

/**
 * Polling probes. The probe is config inside the start node (`start.polling`),
 * not a graph node. An armed poller runs the probe on a timer; the probe
 * returns nothing, or the start parameters that should start a run.
 */

/** Max agent probe prompt size in UTF-8 bytes. Mirrors the engine CLI limit. */
export const POLL_AGENT_PROMPT_MAX_BYTES = 1024 * 1024;

/** Start parameter names the probe output contract reserves for its own envelope keys. */
export const POLL_RESERVED_PARAM_NAMES: readonly string[] = ["found", "dedupeKey"];

/** Longest dedupeKey a probe may return. Keys are stored per claim for seven days. */
export const POLL_DEDUPE_KEY_MAX_CHARS = 512;

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

const MCP_SERVER_NAME_MAX = 128;
const MCP_SERVERS_MAX = 32;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const MCP_SERVER_NAME_CONTROL = /[\u0000-\u001f\u007f]/;
const MCP_SCOPE_SET: ReadonlySet<string> = new Set(MCP_SCOPES);

function hasProbeTemplate(text: string, shell: boolean): boolean {
  const compiled = compileTemplate(text, { shell });
  if (!compiled.ok) return true;
  return compiled.value.parts.some((part) => part.kind === "expression");
}

function validatePollMcpServers(
  value: unknown,
  probeBase: string,
  fail: (code: string, message: string, pointer: string) => void,
): void {
  if (value === undefined) return;
  const base = `${probeBase}/mcpServers`;
  if (!Array.isArray(value)) {
    fail("E_MCP_SERVERS", "Agent mcpServers must be an array.", base);
    return;
  }
  if (value.length > MCP_SERVERS_MAX) {
    fail("E_MCP_SERVERS", `Agent mcpServers must have at most ${MCP_SERVERS_MAX} entries.`, base);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = `${base}/${index}`;
    const selection = value[index];
    if (!isRecord(selection)) {
      fail("E_MCP_SERVERS", "Agent mcpServers entries must be objects.", entry);
      continue;
    }
    const { name, scope } = selection as { name?: unknown; scope?: unknown };
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > MCP_SERVER_NAME_MAX ||
      MCP_SERVER_NAME_CONTROL.test(name)
    ) {
      fail(
        "E_MCP_SERVERS",
        `Agent mcpServers[${index}].name must be 1-${MCP_SERVER_NAME_MAX} characters with no control characters.`,
        `${entry}/name`,
      );
      continue;
    }
    if (name === "devchestra") {
      fail(
        "E_MCP_SERVERS",
        "Agent mcpServers name 'devchestra' is reserved for DevChestra's own server.",
        `${entry}/name`,
      );
      continue;
    }
    if (typeof scope !== "string" || !MCP_SCOPE_SET.has(scope)) {
      fail(
        "E_MCP_SERVERS",
        `Agent mcpServers[${index}].scope must be one of ${MCP_SCOPES.join(", ")}.`,
        `${entry}/scope`,
      );
      continue;
    }
    const key = `${scope}:${name}`;
    if (seen.has(key)) {
      fail("E_MCP_SERVERS", `Agent mcpServers[${index}] duplicates '${key}'.`, entry);
    } else {
      seen.add(key);
    }
  }
}

function validatePollShellProbe(
  typed: Record<string, unknown>,
  probeBase: string,
  fail: (code: string, message: string, pointer: string) => void,
): void {
  if (typed.workspace !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll shell probe workspace is engine-owned; remove it.",
      `${probeBase}/workspace`,
    );
  }
  if (typed.allowFailure !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll shell probe allowFailure is engine-owned; a non-zero exit is always a probe failure.",
      `${probeBase}/allowFailure`,
    );
  }
  const command = typed.command;
  if (typeof command !== "string" || command.trim() === "") {
    fail("E_SHELL_COMMAND", "Shell command must be a non-empty string.", `${probeBase}/command`);
  } else if (hasProbeTemplate(command, true)) {
    fail(
      "E_POLL_PROBE",
      "Poll probe text must not contain {{ }} variables.",
      `${probeBase}/command`,
    );
  }
  const timeout = timeoutBounds(typed.timeoutMin as number | undefined, "timeoutMin");
  if (timeout !== undefined) {
    fail("E_LIMITS", timeout, `${probeBase}/timeoutMin`);
  }
}

function validatePollAgentProbe(
  typed: Record<string, unknown>,
  probeBase: string,
  fail: (code: string, message: string, pointer: string) => void,
  add: (severity: Issue["severity"], code: string, message: string, pointer: string) => void,
  ctx?: ValidationContext,
): void {
  if (typed.output !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll agent probe output is generated from the start params; remove it.",
      `${probeBase}/output`,
    );
  }
  if (typed.workspace !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll agent probe workspace is engine-owned; remove it.",
      `${probeBase}/workspace`,
    );
  }
  if (typed.context !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll agent probe context is not supported; remove it.",
      `${probeBase}/context`,
    );
  }
  if (typed.promptFile !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll agent probe promptFile is not supported; inline the prompt.",
      `${probeBase}/promptFile`,
    );
  }
  if (typed.timeoutMin !== undefined) {
    fail(
      "E_POLL_PROBE",
      "Poll agent probe timeoutMin was moved: use limits.timeoutMin instead of top-level timeoutMin.",
      `${probeBase}/timeoutMin`,
    );
  }
  const prodClis: readonly string[] = PROD_CLIS;
  const cli = typed.cli;
  if (typed.tier !== undefined) {
    if (!isModelTierId(typed.tier)) {
      fail(
        "E_WORKFLOW_INVALID",
        `Agent tier '${String(typed.tier)}' is not supported; use ${MODEL_TIERS.join(", ")}.`,
        `${probeBase}/tier`,
      );
    }
    for (const field of ["cli", "model"] as const) {
      if (typed[field] !== undefined) {
        fail(
          "E_WORKFLOW_INVALID",
          `A poll agent probe with a tier must not set ${field}; the tier supplies the provider and model on each machine.`,
          `${probeBase}/${field}`,
        );
      }
    }
  } else if (cli === undefined) {
    fail("E_WORKFLOW_INVALID", "Poll agent probe must set cli or tier.", `${probeBase}/cli`);
  } else if (typeof cli !== "string" || !prodClis.includes(cli)) {
    if (cli === "fake") {
      add(
        "warning",
        "W_FAKE_CLI",
        "Poll agent probe CLI 'fake' is test-only (requires DEVCHESTRA_ALLOW_FAKE=1 at run time); do not use it for a real poller.",
        `${probeBase}/cli`,
      );
    } else {
      fail(
        "E_WORKFLOW_INVALID",
        `Agent CLI '${String(cli)}' is not supported; use ${PROD_CLIS.join(", ")}. Fake is test-only behind DEVCHESTRA_ALLOW_FAKE=1.`,
        `${probeBase}/cli`,
      );
    }
  } else if (ctx?.disabledClis?.includes(cli as never)) {
    add(
      "warning",
      "W_CLI_DISABLED",
      `Provider '${String(cli)}' is turned off in Settings > Providers. Runs that use this node are blocked.`,
      `${probeBase}/cli`,
    );
  }
  if (typed.model !== undefined) {
    if (typeof typed.model !== "string" || (typed.model as string).trim() === "") {
      fail(
        "E_POLL_PROBE",
        "Poll agent probe model must be a non-empty string.",
        `${probeBase}/model`,
      );
    }
  }
  const prompt = typed.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    fail(
      "E_POLL_PROBE",
      "Poll agent probe prompt must be a non-empty string.",
      `${probeBase}/prompt`,
    );
  } else {
    if (utf8Bytes(prompt) > POLL_AGENT_PROMPT_MAX_BYTES) {
      fail(
        "E_POLL_PROBE",
        `Poll agent probe prompt exceeds the ${POLL_AGENT_PROMPT_MAX_BYTES}-byte limit.`,
        `${probeBase}/prompt`,
      );
    }
    if (hasProbeTemplate(prompt, false)) {
      fail(
        "E_POLL_PROBE",
        "Poll probe text must not contain {{ }} variables.",
        `${probeBase}/prompt`,
      );
    }
  }
  const permissions = typed.permissions;
  if (permissions !== undefined) {
    if (!isRecord(permissions)) {
      fail("E_PERMISSIONS", "Agent permissions are required.", `${probeBase}/permissions`);
    } else {
      if (typeof permissions.network !== "boolean") {
        fail(
          "E_PERMISSIONS",
          "permissions.network must be a boolean.",
          `${probeBase}/permissions/network`,
        );
      }
      if (
        !Array.isArray(permissions.write) ||
        (permissions.write as unknown[]).some(
          (entry) => entry !== "workspace" && entry !== "project",
        )
      ) {
        fail(
          "E_PERMISSIONS",
          "permissions.write must be an array of 'workspace'|'project'.",
          `${probeBase}/permissions/write`,
        );
      } else if ((permissions.write as string[]).includes("project")) {
        fail(
          "E_WORKFLOW_INVALID",
          "Project write permission is not supported; use workspace-only access with a scratch workspace.",
          `${probeBase}/permissions/write`,
        );
      }
      if (
        typeof permissions.network === "boolean" &&
        Array.isArray(permissions.write) &&
        permissions.network &&
        (permissions.write as string[]).includes("project")
      ) {
        add(
          "warning",
          "W_NETWORK_WRITE",
          "Agent has network access and project write access.",
          `${probeBase}/permissions`,
        );
      }
      if (permissions.shell !== undefined && typeof permissions.shell !== "boolean") {
        fail(
          "E_PERMISSIONS",
          "permissions.shell must be a boolean.",
          `${probeBase}/permissions/shell`,
        );
      }
    }
  }
  validatePollMcpServers(typed.mcpServers, probeBase, fail);
  const limits = typed.limits;
  if (isRecord(limits)) {
    const timeout = timeoutBounds(limits.timeoutMin as number | undefined, "limits.timeoutMin");
    if (timeout !== undefined) {
      fail("E_LIMITS", timeout, `${probeBase}/limits/timeoutMin`);
    }
    const validationRetries = retryBounds(
      limits.validationRetries as number | undefined,
      "limits.validationRetries",
    );
    if (validationRetries !== undefined) {
      fail("E_LIMITS", validationRetries, `${probeBase}/limits/validationRetries`);
    }
    const crashRetries = retryBounds(
      limits.crashRetries as number | undefined,
      "limits.crashRetries",
    );
    if (crashRetries !== undefined) {
      fail("E_LIMITS", crashRetries, `${probeBase}/limits/crashRetries`);
    }
    if (limits.maxQuotaWaitHours !== undefined) {
      fail(
        "E_WORKFLOW_INVALID",
        "limits.maxQuotaWaitHours is not supported.",
        `${probeBase}/limits/maxQuotaWaitHours`,
      );
    }
  } else if (limits !== undefined) {
    fail("E_LIMITS", "limits must be an object.", `${probeBase}/limits`);
  }
  if (isRecord(typed.cliOptions) && Object.keys(typed.cliOptions).length > 0) {
    fail(
      "E_WORKFLOW_INVALID",
      "Agent cliOptions are not supported; remove cliOptions.",
      `${probeBase}/cliOptions`,
    );
  }
}

/**
 * Semantic checks for a start node's polling block. Parse (strict Zod
 * objects) already rejects unknown keys; this reports field-level problems
 * against the saved file. Poll-specific problems use E_POLL_PROBE; agent/shell
 * node-rule problems reuse the underlying codes from validateSingleNode
 * (E_WORKFLOW_INVALID, E_PERMISSIONS, E_MCP_SERVERS, E_LIMITS,
 * E_SHELL_COMMAND, E_NODE_NAME, ...). Pointers are under /polling/probe/...
 */
export function validatePollingConfig(
  start: PollStartLike,
  pointerBase: string,
  opts?: { fileId?: string; ctx?: ValidationContext },
): Issue[] {
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
  start.params.forEach((param, index) => {
    if (POLL_RESERVED_PARAM_NAMES.includes(param.name)) {
      fail(
        "E_POLL_PROBE",
        `Parameter '${param.name}' is reserved by the polling output contract (${POLL_RESERVED_PARAM_NAMES.join(", ")}). Rename it to use polling.`,
        `${pointerBase.replace(/\/polling$/, "")}/params/${index}/name`,
      );
    }
  });
  const probe = polling.probe;
  const probeBase = `${pointerBase}/probe`;
  if (!isRecord(probe)) {
    fail("E_POLL_PROBE", "Start polling.probe must be an object.", `${pointerBase}/probe`);
  } else {
    const typed = probe as Record<string, unknown>;
    // id must be 'probe' when present (parse enforces literal; normalize fills when absent).
    if (typed.id !== undefined && typed.id !== POLL_PROBE_ID) {
      fail("E_POLL_PROBE", `Poll probe id must be '${POLL_PROBE_ID}'.`, `${probeBase}/id`);
    }
    // name: optional (defaults to 'Poll probe' in normalize); when present reuse node-name rule.
    if (typed.name !== undefined) {
      if (typeof typed.name !== "string" || typed.name.trim() === "" || typed.name.length > 200) {
        fail(
          "E_NODE_NAME",
          "Poll probe name must be a non-empty string (max 200).",
          `${probeBase}/name`,
        );
      }
    }
    // supervise/env reuse node-base rules (underlying codes).
    if (typed.supervise !== undefined && typed.supervise !== "default") {
      fail(
        "E_WORKFLOW_INVALID",
        `Poll probe supervise mode '${String(typed.supervise)}' is not supported; use 'default' or omit it.`,
        `${probeBase}/supervise`,
      );
    }
    if (
      typed.env !== undefined &&
      (!Array.isArray(typed.env) || (typed.env as unknown[]).length > 0)
    ) {
      fail(
        "E_WORKFLOW_INVALID",
        "Probe env passthrough is not supported; remove probe.env.",
        `${probeBase}/env`,
      );
    }
    if (typed.type === "shell") {
      validatePollShellProbe(typed, probeBase, fail);
    } else if (typed.type === "agent") {
      validatePollAgentProbe(typed, probeBase, fail, add, opts?.ctx);
    } else {
      fail(
        "E_POLL_PROBE",
        "Start polling.probe.type must be 'shell' or 'agent'.",
        `${probeBase}/type`,
      );
    }
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

function pollFail<T = PollResult>(
  message: string,
  details?: Record<string, unknown>,
): Result<T, DevChestraError> {
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

/** A probe's dedupeKey, or undefined when absent. Over-long keys are a probe failure. */
function readDedupeKey(key: unknown): Result<string | undefined, DevChestraError> {
  if (typeof key !== "string" || key === "") return ok(undefined);
  if (key.length > POLL_DEDUPE_KEY_MAX_CHARS) {
    return pollFail<string | undefined>(
      `Poll probe dedupeKey is ${key.length} characters; the limit is ${POLL_DEDUPE_KEY_MAX_CHARS}.`,
    );
  }
  return ok(key);
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
      // `found` and `dedupeKey` are reserved envelope keys (no start param may use them).
      const envelope = parsed as Record<string, unknown>;
      if (envelope.found === false) return ok(NOTHING);
      if (envelope.found !== undefined) {
        return pollFail(
          'Poll shell probe output must be the parameters object itself, such as {"pr_url": "..."}. Only {"found": false} is accepted as an envelope.',
        );
      }
      const raw: Record<string, unknown> = { ...envelope };
      const dedupeKey = readDedupeKey(raw.dedupeKey);
      if (!dedupeKey.ok) return err(dedupeKey.error);
      delete raw.dedupeKey;
      if (Object.keys(raw).length === 0) return ok(NOTHING);
      return checkedParams(start, raw, dedupeKey.value);
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
  const dedupeKey = readDedupeKey(output.dedupeKey);
  if (!dedupeKey.ok) return err(dedupeKey.error);
  return checkedParams(start, raw, dedupeKey.value);
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
      dedupeKey: { type: "string", maxLength: POLL_DEDUPE_KEY_MAX_CHARS },
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

/** The probe node's own timeout in minutes: `timeoutMin` for a shell probe, `limits.timeoutMin` for an agent probe. */
export function pollProbeTimeoutMin(probe: PollProbe): number {
  if (probe.type === "shell") return probe.timeoutMin ?? 10;
  return probe.limits?.timeoutMin ?? 30;
}
