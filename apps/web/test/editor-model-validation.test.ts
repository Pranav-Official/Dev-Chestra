import type { ValidationReport, WorkflowFile } from "@devchestra/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createValidationClient,
  type ValidationWorkerLike,
} from "../src/editor/model/validation.js";
import { emptyRequires } from "../src/editor/model/validation-report.js";

function blank(): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "wf",
    name: "Workflow",
    graph: { nodes: [], edges: [] },
  };
}

function report(ok: boolean): ValidationReport {
  return {
    ok,
    errors: ok ? [] : [{ severity: "error", code: "E_TEST", message: "invalid", nodeId: "agent" }],
    warnings: [],
    requires: emptyRequires(),
  };
}

class FakeWorker implements ValidationWorkerLike {
  messages: Array<Record<string, unknown>> = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;

  postMessage(value: unknown): void {
    this.messages.push(value as Record<string, unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }

  request(): Record<string, unknown> {
    const message = this.messages[0];
    if (message === undefined) throw new Error("no request posted");
    return message;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("validation client", () => {
  it("posts to the worker and delivers the latest result", () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = createValidationClient({
      onResult,
      debounceMs: 0,
      createWorker: () => worker,
    });
    client.validate(blank(), 1);
    const request = worker.request();
    expect(request.type).toBe("validate");
    expect(request.revision).toBe(1);
    worker.reply({
      type: "result",
      requestId: request.requestId,
      revision: 1,
      report: report(true),
    });
    expect(onResult).toHaveBeenCalledWith(report(true), 1);
    client.dispose();
  });

  it("ignores a stale worker and only reports the latest revision", () => {
    const workers: FakeWorker[] = [];
    const onResult = vi.fn();
    const client = createValidationClient({
      onResult,
      debounceMs: 0,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    client.validate(blank(), 1);
    const first = workers[0];
    if (first === undefined) throw new Error("missing first worker");
    const staleHandler = first.onmessage;
    client.validate(blank(), 2);
    const second = workers[1];
    if (second === undefined) throw new Error("missing second worker");
    const request = second.request();
    staleHandler?.({
      data: {
        type: "result",
        requestId: first.request().requestId,
        revision: 1,
        report: report(false),
      },
    });
    expect(onResult).not.toHaveBeenCalled();
    second.reply({
      type: "result",
      requestId: request.requestId,
      revision: 2,
      report: report(true),
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(report(true), 2);
    client.dispose();
  });

  it("terminates a hung worker, reports a timeout and respawns for the next revision", () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const onResult = vi.fn();
    const client = createValidationClient({
      onResult,
      debounceMs: 0,
      timeoutMs: 20,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    client.validate(blank(), 1);
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(20);
    expect(workers[0]?.terminated).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(1);
    const timedOut = onResult.mock.calls[0]?.[0] as ValidationReport;
    expect(timedOut.errors[0]?.code).toBe("E_VALIDATION_TIMEOUT");

    client.validate(blank(), 2);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.messages[0]?.revision).toBe(2);
    client.dispose();
  });

  it("surfaces worker-construction failures and retries on the next revision", () => {
    let calls = 0;
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = createValidationClient({
      onResult,
      debounceMs: 0,
      createWorker: () => {
        calls += 1;
        if (calls === 1) throw new Error("Worker blocked by policy");
        return worker;
      },
    });
    expect(() => client.validate(blank(), 1)).not.toThrow();
    expect(onResult).toHaveBeenCalledTimes(1);
    const failed = onResult.mock.calls[0]?.[0] as ValidationReport;
    expect(failed.errors[0]?.code).toBe("E_VALIDATION_WORKER");
    expect(worker.messages).toHaveLength(0);

    client.validate(blank(), 2);
    expect(worker.messages[0]?.revision).toBe(2);
    client.dispose();
  });

  it("rejects an oversized document before posting to a worker", () => {
    const onResult = vi.fn();
    const createWorker = vi.fn(() => new FakeWorker());
    const client = createValidationClient({
      onResult,
      debounceMs: 0,
      maxBytes: 8,
      createWorker,
    });
    client.validate(blank(), 4);
    expect(createWorker).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
    const oversized = onResult.mock.calls[0]?.[0] as ValidationReport;
    expect(oversized.errors[0]?.code).toBe("E_EDITOR_DOC_TOO_LARGE");
    client.dispose();
  });

  it("cleans up debounce and pending work on dispose", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = createValidationClient({
      onResult,
      debounceMs: 50,
      createWorker: () => worker,
    });
    client.validate(blank(), 1);
    client.dispose();
    vi.advanceTimersByTime(100);
    expect(worker.messages).toHaveLength(0);
    expect(worker.terminated).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
  });
});
