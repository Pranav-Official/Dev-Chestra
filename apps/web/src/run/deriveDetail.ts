import type { EventEnvelope, JsonValue } from "@devchestra/core";

export interface DerivedAttempt {
  attempt: number;
  generation: number;
  mode: "fresh" | "resume";
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  exitCode: number | null;
  cli: string | null;
  model: string | null;
  sessionId: string | null;
  errors: string[];
}

export interface DerivedInput {
  inputsHash: string;
  inputs: JsonValue | null;
  eventId: number;
}

export interface DerivedOutput {
  outputId: string;
  outputHash: string;
  validatedEventId: number | null;
  recordedEventId: number | null;
}

export interface DerivedProcess {
  pid: number;
  pidStart: string;
  binary: string;
  cwd: string;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  exitCode: number | null;
  eventId: number;
}

export interface DerivedWorkspace {
  mode: string | null;
  dir: string;
  branch: string | null;
  baseSha: string | null;
  commitSha: string | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  eventId: number;
}

export interface DerivedDetail {
  attempts: DerivedAttempt[];
  input: DerivedInput | null;
  output: DerivedOutput | null;
  process: DerivedProcess | null;
  workspace: DerivedWorkspace | null;
  statusEvents: { from: string; to: string; reason: string | null; eventId: number }[];
  lastEventId: number;
}

function payload(event: EventEnvelope): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Derive historical execution facts from the event log only. This is what the
 * replay panel renders; it never borrows the latest execution API response.
 */
export function deriveDetail(
  events: readonly EventEnvelope[],
  path: string,
  upTo: number,
): DerivedDetail {
  const detail: DerivedDetail = {
    attempts: [],
    input: null,
    output: null,
    process: null,
    workspace: null,
    statusEvents: [],
    lastEventId: upTo,
  };
  const attempts = new Map<string, DerivedAttempt>();

  for (const event of events) {
    if (event.id > upTo) break;
    if (event.path !== path) continue;
    const data = payload(event);
    const attempt = number(data.attempt);
    const generation = number(data.generation);
    const key = attempt === null ? "" : `${attempt}:${generation ?? 0}`;
    const current = key === "" ? undefined : attempts.get(key);

    switch (event.type) {
      case "node.attempt.started":
        if (attempt !== null) {
          const entry: DerivedAttempt = {
            attempt,
            generation: generation ?? 0,
            mode: data.mode === "resume" ? "resume" : "fresh",
            startedAt: event.ts,
            stoppedAt: null,
            stopReason: null,
            exitCode: null,
            cli: string(data.cli),
            model: string(data.model),
            sessionId: null,
            errors: [],
          };
          attempts.set(key, entry);
          detail.attempts.push(entry);
        }
        break;
      case "node.session.captured":
        if (current !== undefined) current.sessionId = string(data.sessionId);
        break;
      case "node.output.rejected":
        if (current !== undefined) {
          const errors = Array.isArray(data.errors) ? data.errors : [];
          for (const item of errors) {
            const issue = item as { path?: unknown; message?: unknown };
            current.errors.push(
              `${String(issue.path ?? "")} ${String(issue.message ?? "")}`.trim(),
            );
          }
        }
        break;
      case "node.input.resolved":
        detail.input = {
          inputsHash: string(data.inputsHash) ?? "",
          inputs: (data.inputs ?? null) as JsonValue | null,
          eventId: event.id,
        };
        break;
      case "node.output.validated": {
        const outputId = string(data.outputId) ?? "";
        const outputHash = string(data.outputHash) ?? "";
        detail.output = {
          outputId,
          outputHash,
          validatedEventId: event.id,
          recordedEventId: detail.output?.recordedEventId ?? null,
        };
        break;
      }
      case "node.output.recorded":
        detail.output = {
          outputId: string(data.outputId) ?? "",
          outputHash: string(data.outputHash) ?? "",
          validatedEventId: detail.output?.validatedEventId ?? null,
          recordedEventId: event.id,
        };
        break;
      case "node.process.spawned":
        detail.process = {
          pid: number(data.pid) ?? 0,
          pidStart: string(data.pidStart) ?? "",
          binary: string(data.binary) ?? "",
          cwd: string(data.cwd) ?? "",
          startedAt: event.ts,
          stoppedAt: null,
          stopReason: null,
          exitCode: null,
          eventId: event.id,
        };
        break;
      case "node.process.stopped":
        if (detail.process !== null) {
          detail.process.stoppedAt = event.ts;
          detail.process.stopReason = string(data.reason);
          detail.process.exitCode = number(data.exitCode);
          if (current !== undefined) {
            current.stoppedAt = event.ts;
            current.stopReason = string(data.reason);
            current.exitCode = number(data.exitCode);
          }
        }
        break;
      case "workspace.created":
        detail.workspace = {
          mode: string(data.mode),
          dir: string(data.dir) ?? "",
          branch: string(data.branch),
          baseSha: string(data.baseSha),
          commitSha: null,
          filesChanged: null,
          insertions: null,
          deletions: null,
          eventId: event.id,
        };
        break;
      case "node.workspace.finalized":
        detail.workspace = {
          mode: detail.workspace?.mode ?? null,
          dir: string(data.dir) ?? detail.workspace?.dir ?? "",
          branch: detail.workspace?.branch ?? null,
          baseSha: detail.workspace?.baseSha ?? null,
          commitSha: string(data.commitSha),
          filesChanged: detail.workspace?.filesChanged ?? null,
          insertions: detail.workspace?.insertions ?? null,
          deletions: detail.workspace?.deletions ?? null,
          eventId: event.id,
        };
        break;
      case "workspace.committed":
        detail.workspace = {
          mode: detail.workspace?.mode ?? null,
          dir: detail.workspace?.dir ?? "",
          branch: detail.workspace?.branch ?? null,
          baseSha: detail.workspace?.baseSha ?? null,
          commitSha: string(data.sha),
          filesChanged: number(data.filesChanged),
          insertions: number(data.insertions),
          deletions: number(data.deletions),
          eventId: event.id,
        };
        break;
      case "node.state":
        detail.statusEvents.push({
          from: string(data.from) ?? "?",
          to: string(data.to) ?? "?",
          reason: string(data.reason),
          eventId: event.id,
        });
        break;
      default:
        break;
    }
  }
  detail.attempts.sort((left, right) => left.attempt - right.attempt);
  return detail;
}
