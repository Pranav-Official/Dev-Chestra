import type { ExecutionIdentity, Path, RunId } from "@devchestra/core";
import { appendEvents } from "./events.js";
import { requireCurrent } from "./executions.js";
import { hashJsonSync } from "./hash.js";
import { assertRunActive } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import type {
  AcceptedOutput,
  AcceptedSubmissionOutcome,
  AlreadyAcceptedOutcome,
  ExecutionRow,
  InvalidSubmission,
  Receipt,
  RejectedSubmissionOutcome,
  SubmitInput,
  SubmitOutcome,
  ValidSubmission,
} from "./types.js";
import { fail, parseJson } from "./util.js";

interface OutputDbRow {
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

interface ReceiptDbRow {
  run_id: string;
  path: string;
  attempt: number;
  generation: number;
  call_id: string;
  request_fingerprint: string;
  ok: number;
  validation_attempt: number | null;
  validation_attempts_after: number;
  error_code: string | null;
  error_message: string | null;
  output_id: string | null;
  event_id: number;
  created_at: number;
}

function safeFingerprint(value: unknown): string {
  try {
    return hashJsonSync(value);
  } catch (error) {
    fail("E_VALIDATION", "Value cannot be canonically hashed", { cause: error });
  }
}

export function submit(runtime: Runtime, input: SubmitInput): SubmitOutcome {
  const callIdFinding = runtime.secrets.scanString(input.callId, "$.callId");
  if (callIdFinding) {
    fail("E_VALIDATION", "callId contains a secret", {
      path: callIdFinding.path,
      source: callIdFinding.source,
      label: callIdFinding.label,
    });
  }
  const execution = requireCurrent(runtime, input.identity);
  const requestFingerprint = safeFingerprint(input.request);
  const existing = readReceipt(runtime, input.identity, input.callId);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      fail("E_CONFLICT", "This callId was already committed with a different request payload", {
        callId: input.callId,
      });
    }
    // A committed receipt is replayed even after success/failure/exhaustion.
    return duplicateOutcome(runtime, existing, execution.validationLimit);
  }
  const accepted = readAcceptedRow(
    runtime,
    input.identity.runId,
    input.identity.path,
    input.identity.attempt,
  );
  if (accepted) return alreadyAcceptedOutcome(runtime, accepted);
  assertRunActive(runtime, input.identity.runId);
  if (!["running", "validating"].includes(execution.status)) {
    fail("E_CONFLICT", `Cannot submit a new result while execution is ${execution.status}`);
  }
  if (execution.validationAttempts >= execution.validationLimit) {
    fail("E_ATTEMPTS_EXHAUSTED", "No validation attempts left", {
      attempts: execution.validationAttempts,
      limit: execution.validationLimit,
    });
  }

  if (input.ok) return submitValid(runtime, input, execution, requestFingerprint);
  return submitInvalid(runtime, input, execution, requestFingerprint);
}

function submitValid(
  runtime: Runtime,
  input: ValidSubmission,
  execution: ExecutionRow,
  requestFingerprint: string,
): AcceptedSubmissionOutcome {
  const finding = runtime.secrets.scanValue(input.output);
  if (finding) {
    fail("E_VALIDATION", "Submitted output contains a secret; remove it and resubmit", {
      path: finding.path,
      source: finding.source,
      label: finding.label,
    });
  }
  const outputText = JSON.stringify(input.output);
  if (outputText === undefined) fail("E_VALIDATION", "Submitted output is not JSON-serializable");
  const outputHash = safeFingerprint(input.output);
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
      outputHash,
      Buffer.byteLength(outputText, "utf8"),
      outputText,
      now(runtime),
    );

  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.output.validated",
      actor: "engine",
      payload: {
        attempt: input.identity.attempt,
        generation: input.identity.generation,
        outputId,
        outputHash,
        ...(input.schemaHash === undefined ? {} : { schemaHash: input.schemaHash }),
      },
    },
  ]);
  if (!event) fail("E_INTERNAL", "Acceptance event was not appended");

  const receipt = insertReceipt(runtime, {
    identity: input.identity,
    callId: input.callId,
    requestFingerprint,
    ok: true,
    validationAttempt: null,
    validationAttemptsAfter: execution.validationAttempts,
    errorCode: null,
    errorMessage: null,
    outputId,
    eventId: event.id,
  });
  const output = getAcceptedOutput(
    runtime,
    input.identity.runId,
    input.identity.path,
    input.identity.attempt,
  );
  if (!output) fail("E_INTERNAL", "Accepted output disappeared inside its transaction");
  return { kind: "accepted", duplicate: false, receipt, output, eventId: event.id };
}

function submitInvalid(
  runtime: Runtime,
  input: InvalidSubmission,
  execution: ExecutionRow,
  requestFingerprint: string,
): RejectedSubmissionOutcome {
  const nextAttempt = execution.validationAttempts + 1;
  if (input.validationAttempt !== undefined && input.validationAttempt !== nextAttempt) {
    fail(
      "E_CONFLICT",
      `validationAttempt ${input.validationAttempt} does not match next durable attempt ${nextAttempt}`,
    );
  }
  const validationAttemptsLeft = Math.max(0, execution.validationLimit - nextAttempt);
  const [event] = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.output.rejected",
      actor: "engine",
      payload: {
        attempt: input.identity.attempt,
        generation: input.identity.generation,
        validationAttempt: nextAttempt,
        errors: input.errors.map((error) => ({ path: error.path, message: error.message })),
      },
    },
  ]);
  if (!event) fail("E_INTERNAL", "Rejection event was not appended");

  runtime.db
    .prepare("UPDATE executions SET validation_attempts = ? WHERE run_id = ? AND path = ?")
    .run(nextAttempt, input.identity.runId, input.identity.path);

  const errorMessage = runtime.secrets.redactString(
    input.errors.map((error) => `${error.path}: ${error.message}`).join("; "),
  );
  const receipt = insertReceipt(runtime, {
    identity: input.identity,
    callId: input.callId,
    requestFingerprint,
    ok: false,
    validationAttempt: nextAttempt,
    validationAttemptsAfter: nextAttempt,
    errorCode: input.errorCode ?? null,
    errorMessage: errorMessage === "" ? null : errorMessage,
    outputId: null,
    eventId: event.id,
  });
  return {
    kind: "rejected",
    duplicate: false,
    receipt,
    validationAttempt: nextAttempt,
    validationAttemptsLeft,
    eventId: event.id,
  };
}

function alreadyAcceptedOutcome(runtime: Runtime, row: OutputDbRow): AlreadyAcceptedOutcome {
  const events = runtime.db
    .prepare(
      `SELECT id, payload FROM events
        WHERE run_id = ? AND path = ? AND type = 'node.output.validated'
        ORDER BY id ASC`,
    )
    .all(row.run_id, row.path) as { id: number; payload: string }[];
  for (const event of events) {
    const payload = parseJson<{
      attempt?: number;
      generation?: number;
      outputId?: string;
    }>(event.payload);
    if (
      payload.outputId === row.id &&
      payload.attempt === row.attempt &&
      payload.generation === row.generation
    ) {
      return { kind: "already_accepted", output: mapOutput(row), acceptedEventId: event.id };
    }
  }
  fail("E_INTERNAL", "Accepted output has no matching validated event");
}

function duplicateOutcome(runtime: Runtime, receipt: Receipt, limit: number): SubmitOutcome {
  if (!receipt.ok) {
    return {
      kind: "rejected",
      duplicate: true,
      receipt,
      validationAttempt: receipt.validationAttempt ?? 0,
      validationAttemptsLeft: Math.max(0, limit - receipt.validationAttemptsAfter),
      eventId: receipt.eventId,
    };
  }
  if (!receipt.outputId) fail("E_INTERNAL", "Accepted receipt has no output id");
  const row = runtime.db.prepare("SELECT * FROM outputs WHERE id = ?").get(receipt.outputId) as
    | OutputDbRow
    | undefined;
  if (!row) fail("E_INTERNAL", "Accepted receipt references a missing output");
  return {
    kind: "accepted",
    duplicate: true,
    receipt,
    output: mapOutput(row),
    eventId: receipt.eventId,
  };
}

function insertReceipt(
  runtime: Runtime,
  input: {
    identity: ExecutionIdentity;
    callId: string;
    requestFingerprint: string;
    ok: boolean;
    validationAttempt: number | null;
    validationAttemptsAfter: number;
    errorCode: string | null;
    errorMessage: string | null;
    outputId: string | null;
    eventId: number;
  },
): Receipt {
  const createdAt = now(runtime);
  runtime.db
    .prepare(
      `INSERT INTO tool_receipts
         (run_id, path, attempt, generation, call_id, request_fingerprint, ok,
          validation_attempt, validation_attempts_after, error_code, error_message,
          output_id, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
      input.callId,
      input.requestFingerprint,
      input.ok ? 1 : 0,
      input.validationAttempt,
      input.validationAttemptsAfter,
      input.errorCode,
      input.errorMessage,
      input.outputId,
      input.eventId,
      createdAt,
    );
  return {
    runId: input.identity.runId,
    path: input.identity.path,
    attempt: input.identity.attempt,
    generation: input.identity.generation,
    callId: input.callId,
    requestFingerprint: input.requestFingerprint,
    ok: input.ok,
    validationAttempt: input.validationAttempt,
    validationAttemptsAfter: input.validationAttemptsAfter,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    outputId: input.outputId,
    eventId: input.eventId,
    createdAt,
  };
}

export function readReceipt(
  runtime: Runtime,
  identity: ExecutionIdentity,
  callId: string,
): Receipt | null {
  const row = runtime.db
    .prepare(
      `SELECT * FROM tool_receipts
        WHERE run_id = ? AND path = ? AND attempt = ? AND generation = ? AND call_id = ?`,
    )
    .get(identity.runId, identity.path, identity.attempt, identity.generation, callId) as
    | ReceiptDbRow
    | undefined;
  return row ? mapReceipt(row) : null;
}

function mapReceipt(row: ReceiptDbRow): Receipt {
  return {
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    callId: row.call_id,
    requestFingerprint: row.request_fingerprint,
    ok: row.ok === 1,
    validationAttempt: row.validation_attempt,
    validationAttemptsAfter: row.validation_attempts_after,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    outputId: row.output_id,
    eventId: row.event_id,
    createdAt: row.created_at,
  };
}

function readAcceptedRow(
  runtime: Runtime,
  runId: RunId,
  path: Path,
  attempt: number,
): OutputDbRow | null {
  const row = runtime.db
    .prepare(
      `SELECT * FROM outputs
        WHERE run_id = ? AND path = ? AND attempt = ? AND kind = 'output'`,
    )
    .get(runId, path, attempt) as OutputDbRow | undefined;
  return row ?? null;
}

function mapOutput(row: OutputDbRow): AcceptedOutput {
  return {
    id: row.id,
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
    hash: row.hash,
    bytes: row.bytes,
    json: parseJson(row.json),
    createdAt: row.created_at,
  };
}

export function getAcceptedOutput(
  runtime: Runtime,
  runId: RunId,
  path: Path,
  attempt: number,
): AcceptedOutput | null {
  const row = readAcceptedRow(runtime, runId, path, attempt);
  return row ? mapOutput(row) : null;
}

export function countNoSubmit(runtime: Runtime, runId: RunId, path: Path, attempt: number): number {
  const row = runtime.db
    .prepare(
      `SELECT COUNT(*) AS count FROM tool_receipts
        WHERE run_id = ? AND path = ? AND attempt = ? AND ok = 0
          AND error_code = 'E_NO_SUBMIT'`,
    )
    .get(runId, path, attempt) as { count: number };
  return row.count;
}

export function validationLeft(runtime: Runtime, identity: ExecutionIdentity): number {
  const execution = requireCurrent(runtime, identity);
  return Math.max(0, execution.validationLimit - execution.validationAttempts);
}
