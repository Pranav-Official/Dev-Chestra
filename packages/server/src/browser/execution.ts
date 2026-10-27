import {
  type EventEnvelope,
  type ExecStatus,
  type JsonObject,
  type JsonValue,
  type NodeKind,
  parsePath,
} from "@relay/core";
import type { AcceptedOutput, ExecutionHistory, ExecutionRow, ProcessHistory } from "@relay/store";
import type {
  AttemptView,
  BrowserQueryPort,
  ExecutionSummary,
  ExecutionUsage,
  OutputPreview,
  ProcessView,
  StopReason,
  WorkspaceView,
} from "./ports.js";

const PREVIEW_LIMIT = 64 * 1024;

function parsesAsJson(value: unknown): value is JsonValue {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

export function previewFromOutput(output: AcceptedOutput): OutputPreview {
  const bytes = Buffer.byteLength(JSON.stringify(output.json) ?? "", "utf8");
  const truncated = bytes > PREVIEW_LIMIT;
  return {
    id: output.id,
    hash: output.hash,
    bytes,
    truncated,
    data: truncated || !parsesAsJson(output.json) ? null : (output.json as JsonValue),
    contentType: "json",
  };
}

function previewFromInput(event: EventEnvelope): OutputPreview | null {
  const payload = event.payload as {
    inputsHash?: unknown;
    inputs?: unknown;
  };
  if (typeof payload.inputsHash !== "string" || payload.inputs === undefined) return null;
  const bytes = Buffer.byteLength(JSON.stringify(payload.inputs) ?? "", "utf8");
  const truncated =
    bytes > PREVIEW_LIMIT ||
    (typeof payload.inputs === "object" &&
      payload.inputs !== null &&
      (payload.inputs as { truncated?: unknown }).truncated === true);
  return {
    id: `event:${event.id}`,
    hash: payload.inputsHash,
    bytes,
    truncated,
    data: truncated || !parsesAsJson(payload.inputs) ? null : (payload.inputs as JsonValue),
    contentType: "json",
  };
}

export function executionSummary(row: ExecutionRow): ExecutionSummary {
  return {
    runId: row.runId,
    path: row.path,
    nodeId: row.nodeId,
    status: row.status as ExecStatus,
    kind: row.kind as NodeKind | null,
    attempt: row.attempt,
    generation: row.generation,
    cli: row.cli,
    model: row.model,
    sessionId: row.sessionId,
    sessionCwd: row.sessionCwd,
    outputId: row.outputId,
    errorCode: row.errorCode as ExecutionSummary["errorCode"],
    errorMessage: row.errorMessage,
    branch: row.branch,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    validationAttempts: row.validationAttempts,
    validationLimit: row.validationLimit,
    crashAttempts: row.crashAttempts,
    lastEventId: row.lastEventId,
  };
}

function payloadOf(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function sameAttempt(event: EventEnvelope, attempt: number, generation: number): boolean {
  const payload = payloadOf(event);
  return payload.attempt === attempt && payload.generation === generation;
}

export function buildAttempts(
  execution: ExecutionRow,
  history: ExecutionHistory,
): { attempts: AttemptView[]; process: ProcessView | null } {
  const attempts: AttemptView[] = history.attempts.map((attempt) => ({
    attempt: attempt.attempt,
    generation: attempt.generation,
    mode: attempt.mode === "resume" ? "resume" : "fresh",
    startedAt: attempt.startedAt,
    stoppedAt: attempt.stoppedAt,
    stopReason:
      attempt.stopReason === "exited" ||
      attempt.stopReason === "killed" ||
      attempt.stopReason === "grace_timeout" ||
      attempt.stopReason === "crash"
        ? (attempt.stopReason as StopReason)
        : null,
    exitCode: attempt.exitCode,
    cli: attempt.cli,
    model: attempt.model,
    sessionId: attempt.sessionId,
  }));
  attempts.sort(
    (left, right) => left.attempt - right.attempt || left.generation - right.generation,
  );
  const current =
    history.attempts.find(
      (attempt) =>
        attempt.attempt === execution.attempt && attempt.generation === execution.generation,
    ) ?? null;
  if (
    current === null &&
    !attempts.some(
      (attempt) =>
        attempt.attempt === execution.attempt && attempt.generation === execution.generation,
    )
  ) {
    attempts.push({
      attempt: execution.attempt,
      generation: execution.generation,
      mode: "fresh",
      startedAt: execution.startedAt,
      stoppedAt: execution.endedAt,
      stopReason: null,
      exitCode: null,
      cli: execution.cli,
      model: execution.model,
      sessionId: execution.sessionId,
    });
  }
  return { attempts, process: processView(current?.process ?? null) };
}

function processView(process: ProcessHistory | null): ProcessView | null {
  if (
    process === null ||
    process.pid === null ||
    process.pid <= 0 ||
    process.pidStart === null ||
    process.binary === null ||
    process.cwd === null ||
    process.startedAt === null
  ) {
    return null;
  }
  const stopReason =
    process.stopReason === "exited" ||
    process.stopReason === "killed" ||
    process.stopReason === "grace_timeout" ||
    process.stopReason === "crash"
      ? (process.stopReason as StopReason)
      : null;
  return {
    pid: process.pid,
    pidStart: process.pidStart,
    binary: process.binary,
    cwd: process.cwd,
    startedAt: process.startedAt,
    stoppedAt: process.stoppedAt,
    stopReason,
    exitCode: process.exitCode,
  };
}

export function buildWorkspace(
  execution: ExecutionRow,
  events: readonly EventEnvelope[],
): WorkspaceView | null {
  let commitSha: string | null = null;
  let filesChanged: number | null = null;
  let insertions: number | null = null;
  let deletions: number | null = null;
  let baseSha: string | null = null;
  for (const event of events) {
    const payload = payloadOf(event);
    if (sameAttempt(event, execution.attempt, execution.generation)) {
      if (event.type === "workspace.created" && typeof payload.baseSha === "string") {
        baseSha = payload.baseSha;
      }
      if (event.type === "workspace.finalized" && typeof payload.commitSha === "string") {
        commitSha = payload.commitSha;
      }
      if (event.type === "workspace.committed") {
        if (typeof payload.sha === "string") commitSha = payload.sha;
        if (typeof payload.filesChanged === "number") filesChanged = payload.filesChanged;
        if (typeof payload.insertions === "number") insertions = payload.insertions;
        if (typeof payload.deletions === "number") deletions = payload.deletions;
      }
    }
  }
  if (execution.workspaceDir === null && commitSha === null && execution.branch === null)
    return null;
  return {
    dir: execution.workspaceDir ?? "",
    branch: execution.branch,
    baseSha,
    commitSha,
    filesChanged,
    insertions,
    deletions,
  };
}

export function buildUsage(
  events: readonly EventEnvelope[],
  execution: ExecutionRow,
): ExecutionUsage {
  let usage: ExecutionUsage = {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costSource: "none",
  };
  for (const event of events) {
    if (event.type !== "node.usage") continue;
    if (!sameAttempt(event, execution.attempt, execution.generation)) continue;
    const payload = payloadOf(event);
    usage = {
      tokensIn: typeof payload.tokensIn === "number" ? payload.tokensIn : usage.tokensIn,
      tokensOut: typeof payload.tokensOut === "number" ? payload.tokensOut : usage.tokensOut,
      costUsd: typeof payload.costUsd === "number" ? payload.costUsd : usage.costUsd,
      costSource:
        payload.costSource === "reported" ||
        payload.costSource === "estimated" ||
        payload.costSource === "none"
          ? payload.costSource
          : usage.costSource,
    };
  }
  return usage;
}

export function findInput(
  events: readonly EventEnvelope[],
  execution: ExecutionRow,
): OutputPreview | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== "node.input.resolved") continue;
    if (!sameAttempt(event, execution.attempt, execution.generation)) continue;
    const preview = previewFromInput(event);
    if (preview !== null) return preview;
  }
  return null;
}

export function parseParams(value: unknown): JsonObject | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

export function decodeExecutionPath(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const parsed = parsePath(value);
  return parsed.ok ? value : null;
}

export async function collectExecutionEvents(
  store: BrowserQueryPort,
  runId: string,
  path: string,
): Promise<EventEnvelope[]> {
  const result: EventEnvelope[] = [];
  let after = 0;
  for (;;) {
    const page = await store.eventsPage(runId, {
      after,
      limit: 500,
      pathPrefix: path,
    });
    const matching = page.events.filter((event) => event.path === path);
    result.push(...matching);
    if (!page.hasMore || page.events.length === 0) break;
    const next = page.events[page.events.length - 1]?.id ?? 0;
    if (next <= after) break;
    after = next;
  }
  return result;
}

export function latestTranscriptRef(
  history: ExecutionHistory,
): { attempt: number; generation: number } | null {
  const latest = history.latestTranscript;
  if (latest === null) return null;
  return { attempt: latest.attempt, generation: latest.generation };
}
