import type { ValidationReport, WorkflowFile } from "@relay/schema";
import { isRecord } from "@relay/core";
import { errorReport } from "./validation-report.js";

export const VALIDATION_DEBOUNCE_MS = 150;
export const VALIDATION_TIMEOUT_MS = 2_000;
export const MAX_EDITOR_WORKFLOW_BYTES = 1024 * 1024;

export interface ValidationWorkerLike {
  postMessage(value: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ValidationClientOptions {
  onResult(report: ValidationReport, revision: number): void;
  debounceMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  createWorker?: () => ValidationWorkerLike;
}

export interface ValidationClient {
  validate(file: WorkflowFile, revision: number): void;
  dispose(): void;
}

interface Reply {
  type: "result" | "error";
  requestId: number;
  revision: number;
  report?: unknown;
  message?: unknown;
}

function isReply(value: unknown): value is Reply {
  if (!isRecord(value)) return false;
  return (
    (value.type === "result" || value.type === "error") &&
    typeof value.requestId === "number" &&
    typeof value.revision === "number"
  );
}

function isReport(value: unknown): value is ValidationReport {
  if (!isRecord(value)) return false;
  return (
    typeof value.ok === "boolean" &&
    Array.isArray(value.errors) &&
    Array.isArray(value.warnings) &&
    isRecord(value.requires)
  );
}

function byteLength(text: string): number {
  return typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).length;
}

function browserWorker(): ValidationWorkerLike {
  return new Worker(new URL("./validation.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as ValidationWorkerLike;
}

export function createValidationClient(options: ValidationClientOptions): ValidationClient {
  const debounceMs = options.debounceMs ?? VALIDATION_DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? VALIDATION_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_EDITOR_WORKFLOW_BYTES;
  const createWorker = options.createWorker ?? browserWorker;

  let disposed = false;
  let worker: ValidationWorkerLike | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let latest: { file: WorkflowFile; revision: number } | null = null;
  let latestRevision = -1;
  let lastDelivered = -1;
  let nextRequestId = 0;
  let pending: { id: number; revision: number } | null = null;

  function clearTimeoutTimer(): void {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  function teardownWorker(): void {
    if (worker === null) return;
    worker.onmessage = null;
    worker.onerror = null;
    try {
      worker.terminate();
    } catch {
      // A worker that already failed may reject terminate; there is nothing to clean up.
    }
    worker = null;
  }

  function deliver(report: ValidationReport, revision: number): void {
    if (disposed || revision < latestRevision || revision <= lastDelivered) return;
    lastDelivered = revision;
    options.onResult(report, revision);
  }

  function ensureWorker(): ValidationWorkerLike {
    if (worker !== null) return worker;
    const created = createWorker();
    created.onmessage = (event) => handleMessage(created, event.data);
    created.onerror = () => handleWorkerError(created);
    worker = created;
    return created;
  }

  function handleMessage(source: ValidationWorkerLike, data: unknown): void {
    if (source !== worker || !isReply(data)) return;
    if (pending === null || data.requestId !== pending.id) return;
    clearTimeoutTimer();
    pending = null;
    if (data.revision < latestRevision) return;
    if (data.type === "result" && isReport(data.report)) {
      deliver(data.report, data.revision);
      return;
    }
    deliver(
      errorReport(
        "E_VALIDATION_WORKER",
        typeof data.message === "string"
          ? data.message
          : "Validation worker returned an invalid result.",
      ),
      data.revision,
    );
  }

  function handleWorkerError(source: ValidationWorkerLike): void {
    if (source !== worker) return;
    const revision = pending?.revision ?? latestRevision;
    clearTimeoutTimer();
    pending = null;
    teardownWorker();
    deliver(errorReport("E_VALIDATION_WORKER", "Validation worker failed."), revision);
  }

  function sendNow(): void {
    if (disposed || latest === null) return;
    const { file, revision } = latest;
    if (revision < latestRevision) return;

    let serialized: string;
    try {
      const value = JSON.stringify(file);
      if (typeof value !== "string") throw new Error("Workflow is not JSON data.");
      serialized = value;
    } catch (error) {
      deliver(
        errorReport(
          "E_EDITOR_DOC_INVALID",
          error instanceof Error ? error.message : "Workflow is not JSON data.",
        ),
        revision,
      );
      return;
    }

    const bytes = byteLength(serialized);
    if (bytes > maxBytes) {
      deliver(
        errorReport(
          "E_EDITOR_DOC_TOO_LARGE",
          `Workflow is ${bytes} bytes; live validation accepts at most ${maxBytes} bytes.`,
        ),
        revision,
      );
      return;
    }

    clearTimeoutTimer();
    if (pending !== null) {
      pending = null;
      teardownWorker();
    }
    let active: ValidationWorkerLike;
    try {
      active = ensureWorker();
    } catch (error) {
      deliver(
        errorReport(
          "E_VALIDATION_WORKER",
          error instanceof Error ? error.message : "Could not start live validation.",
        ),
        revision,
      );
      return;
    }
    const id = ++nextRequestId;
    pending = { id, revision };
    timeoutTimer = setTimeout(() => {
      if (pending?.id !== id) return;
      const timedOutRevision = pending.revision;
      pending = null;
      teardownWorker();
      deliver(
        errorReport(
          "E_VALIDATION_TIMEOUT",
          `Live validation timed out after ${timeoutMs}ms; the worker was restarted.`,
        ),
        timedOutRevision,
      );
    }, timeoutMs);

    try {
      active.postMessage({
        type: "validate",
        requestId: id,
        revision,
        file,
      });
    } catch (error) {
      clearTimeoutTimer();
      pending = null;
      teardownWorker();
      deliver(
        errorReport(
          "E_VALIDATION_WORKER",
          error instanceof Error ? error.message : "Could not start live validation.",
        ),
        revision,
      );
    }
  }

  return {
    validate(file, revision) {
      if (disposed || !Number.isSafeInteger(revision) || revision < 0) return;
      if (revision < latestRevision) {
        clearTimeoutTimer();
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        pending = null;
        lastDelivered = -1;
        teardownWorker();
      }
      latest = { file, revision };
      latestRevision = revision;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (debounceMs <= 0) {
        debounceTimer = null;
        sendNow();
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        sendNow();
      }, debounceMs);
    },
    dispose() {
      disposed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearTimeoutTimer();
      pending = null;
      latest = null;
      teardownWorker();
    },
  };
}
