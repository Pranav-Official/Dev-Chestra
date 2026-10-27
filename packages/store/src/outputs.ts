import type { ExecutionIdentity, Path, RunId } from "@relay/core";
import { appendEvents } from "./events.js";
import { requireCurrent } from "./executions.js";
import { hashJsonSync } from "./hash.js";
import { assertRunActive } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import { getAcceptedOutput } from "./submissions.js";
import type {
  AcceptedOutput,
  RecordDeterministicOutputInput,
  RecordDeterministicOutputResult,
} from "./types.js";
import { fail, parseJson } from "./util.js";

function recordedEventId(
  runtime: Runtime,
  identity: ExecutionIdentity,
  outputId: string,
): number | null {
  const rows = runtime.db
    .prepare(
      `SELECT id, payload FROM events
        WHERE run_id = ? AND path = ? AND type = 'node.output.recorded'
        ORDER BY id ASC`,
    )
    .all(identity.runId, identity.path) as { id: number; payload: string }[];
  for (const row of rows) {
    const payload = parseJson<{
      attempt?: number;
      generation?: number;
      outputId?: string;
    }>(row.payload);
    if (
      payload.outputId === outputId &&
      payload.attempt === identity.attempt &&
      payload.generation === identity.generation
    ) {
      return row.id;
    }
  }
  return null;
}

export function hasRecordedOutput(runtime: Runtime, identity: ExecutionIdentity): boolean {
  return findRecordedEvent(runtime, identity);
}

function findRecordedEvent(runtime: Runtime, identity: ExecutionIdentity): boolean {
  const rows = runtime.db
    .prepare(
      `SELECT payload FROM events
        WHERE run_id = ? AND path = ? AND type = 'node.output.recorded'`,
    )
    .all(identity.runId, identity.path) as { payload: string }[];
  return rows.some((row) => {
    const payload = parseJson<{ attempt?: number; generation?: number }>(row.payload);
    return payload.attempt === identity.attempt && payload.generation === identity.generation;
  });
}

export function recordDeterministic(
  runtime: Runtime,
  input: RecordDeterministicOutputInput,
): RecordDeterministicOutputResult {
  assertRunActive(runtime, input.identity.runId);
  const execution = requireCurrent(runtime, input.identity);
  if (!["running", "validating"].includes(execution.status)) {
    fail("E_CONFLICT", `Cannot record deterministic output while execution is ${execution.status}`);
  }
  const finding = runtime.secrets.scanValue(input.output);
  if (finding) {
    fail("E_VALIDATION", "Deterministic output contains a secret; remove it and retry", {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  }
  const outputText = JSON.stringify(input.output);
  if (outputText === undefined) {
    fail("E_VALIDATION", "Deterministic output is not JSON-serializable");
  }
  const hash = hashJsonSync(input.output);
  const existing = getAcceptedOutput(
    runtime,
    input.identity.runId,
    input.identity.path,
    input.identity.attempt,
  );
  if (existing) {
    const eventId = recordedEventId(runtime, input.identity, existing.id);
    if (eventId === null) {
      fail("E_CONFLICT", "This attempt already has an accepted output");
    }
    if (existing.hash !== hash) {
      fail("E_CONFLICT", "This attempt already has a different recorded output");
    }
    return { output: existing, eventId, duplicate: true };
  }

  const outputId = runtime.idGen.entryId();
  runtime.db
    .prepare(
      `INSERT INTO outputs (id, run_id, path, attempt, generation, kind, hash, bytes, json, created_at)
       VALUES (?, ?, ?, ?, ?, 'output', ?, ?, ?, ?)`,
    )
    .run(
      outputId,
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
      hash,
      Buffer.byteLength(outputText, "utf8"),
      outputText,
      now(runtime),
    );
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.output.recorded",
      actor: "engine",
      payload: {
        attempt: input.identity.attempt,
        generation: input.identity.generation,
        outputId,
        outputHash: hash,
      },
    } as never,
  ]);
  if (!event) fail("E_INTERNAL", "Recorded output event was not appended");
  const output = getAcceptedOutput(
    runtime,
    input.identity.runId,
    input.identity.path,
    input.identity.attempt,
  );
  if (!output) fail("E_INTERNAL", "Recorded output disappeared inside its transaction");
  return { output, eventId: event.id, duplicate: false };
}

export function getOutput(
  runtime: Runtime,
  runId: RunId,
  path: Path,
  attempt: number,
): AcceptedOutput | null {
  return getAcceptedOutput(runtime, runId, path, attempt);
}
