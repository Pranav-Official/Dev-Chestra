import type { ValidationReport, WorkflowFile } from "@relay/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AutosaveSnapshot,
  type SaveOutcome,
  type SaveRequest,
  WorkflowAutosave,
} from "../src/editor/autosave.js";

function workflow(name = "Demo", nodeName = "Start"): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "demo",
    name,
    graph: {
      nodes: [{ id: "start", type: "start", name: nodeName, params: [] }],
      edges: [],
    },
  };
}

const REPORT = {
  ok: true,
  errors: [],
  warnings: [],
  requires: {
    clis: [],
    networkNodes: [],
    shellCommands: [],
    projectWriteNodes: [],
    worktreeNodes: [],
    providers: [],
    envVars: [],
    irreversibleApprovals: [],
    budget: {},
  },
} as ValidationReport;

function accepted(etag: string): SaveOutcome {
  return { ok: true, etag, validation: REPORT };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(save: (request: SaveRequest) => Promise<SaveOutcome>) {
  const controller = new WorkflowAutosave({
    docId: "p1/w1",
    save,
    contentDebounceMs: 600,
    layoutDebounceMs: 5_000,
  });
  controller.reset({ workflow: workflow(), etag: '"e1"' });
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkflowAutosave", () => {
  it("keeps one request in flight and queues the latest dirty revision", async () => {
    const calls: SaveRequest[] = [];
    const first = deferred<SaveOutcome>();
    const second = deferred<SaveOutcome>();
    const save = vi.fn((request: SaveRequest) => {
      calls.push(request);
      return calls.length === 1 ? first.promise : second.promise;
    });
    const controller = setup(save);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0]?.baseEtag).toBe('"e1"');
    expect(calls[0]?.revision).toBe(1);

    controller.change(workflow("Two"), { layoutOnly: false });
    controller.change(workflow("Three"), { layoutOnly: false });
    expect(controller.getSnapshot().status).toBe("saving");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve(accepted('"e2"'));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1]?.baseEtag).toBe('"e2"');
    expect(calls[1]?.revision).toBe(3);
    expect(calls[1]?.workflow.name).toBe("Three");

    second.resolve(accepted('"e3"'));
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("saved");
    expect(snapshot.savedRevision).toBe(3);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.etag).toBe('"e3"');
  });

  it("marks only the acked revision saved and never clears later edits", async () => {
    const calls: SaveRequest[] = [];
    const pending: ReturnType<typeof deferred<SaveOutcome>>[] = [];
    const save = vi.fn((request: SaveRequest) => {
      calls.push(request);
      const next = deferred<SaveOutcome>();
      pending.push(next);
      return next.promise;
    });
    const controller = setup(save);

    controller.change(workflow("Saved edit"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    controller.change(workflow("Later edit"), { layoutOnly: false });
    pending[0]?.resolve(accepted('"e2"'));
    await vi.advanceTimersByTimeAsync(0);

    const afterAck = controller.getSnapshot();
    expect(afterAck.savedRevision).toBe(1);
    expect(afterAck.revision).toBe(2);
    expect(afterAck.status).toBe("saving");
    expect(calls[1]?.workflow.name).toBe("Later edit");

    pending[1]?.resolve(accepted('"e3"'));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("ignores a stale ack after the controller is reset for another document", async () => {
    const pending = deferred<SaveOutcome>();
    const save = vi.fn(() => pending.promise);
    const controller = setup(save);

    controller.change(workflow("Old"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    controller.reset({ workflow: workflow("Fresh"), etag: '"fresh"' });

    pending.resolve(accepted('"stale"'));
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("clean");
    expect(snapshot.etag).toBe('"fresh"');
    expect(snapshot.savedRevision).toBe(0);
    expect(snapshot.revision).toBe(0);
  });

  it("ignores an ack after dispose", async () => {
    const pending = deferred<SaveOutcome>();
    const seen: AutosaveSnapshot[] = [];
    const controller = setup(() => pending.promise);
    controller.subscribe((snapshot) => seen.push(snapshot));

    controller.change(workflow("Old"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    controller.dispose();
    const idle = controller.getSnapshot();
    pending.resolve(accepted('"stale"'));
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getSnapshot()).toEqual(idle);
    expect(idle.savedRevision).toBe(0);
    expect(seen.some((snapshot) => snapshot.status === "saved")).toBe(false);
  });

  it("does not mark saved on failure and retries the latest payload", async () => {
    const calls: SaveRequest[] = [];
    const outcomes: SaveOutcome[] = [
      { ok: false, kind: "error", message: "offline", code: "E_INTERNAL" },
      accepted('"e2"'),
    ];
    const save = vi.fn((request: SaveRequest) => {
      calls.push(request);
      return Promise.resolve(outcomes.shift() ?? accepted('"e2"'));
    });
    const controller = setup(save);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    let snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.savedRevision).toBe(0);
    expect(snapshot.error).toBe("offline");

    controller.change(workflow("Two"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().savedRevision).toBe(0);

    await expect(controller.saveNow()).resolves.toBe(true);
    expect(calls[1]?.workflow.name).toBe("Two");
    snapshot = controller.getSnapshot();
    expect(snapshot.savedRevision).toBe(2);
    expect(snapshot.etag).toBe('"e2"');
  });

  it("stops on conflict, never overwrites with If-Match star, and rechecks a second 409", async () => {
    const calls: SaveRequest[] = [];
    const outcomes: SaveOutcome[] = [
      { ok: false, kind: "conflict", message: "changed", currentEtag: '"server1"' },
      { ok: false, kind: "conflict", message: "changed again", currentEtag: '"server2"' },
      accepted('"server3"'),
    ];
    const save = vi.fn((request: SaveRequest) => {
      calls.push(request);
      return Promise.resolve(outcomes.shift() ?? accepted('"server3"'));
    });
    const controller = setup(save);

    controller.change(workflow("Local"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("conflict");
    expect(snapshot.conflictEtag).toBe('"server1"');

    controller.change(workflow("Local 2"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    await expect(controller.saveNow()).resolves.toBe(false);

    controller.setBaseEtag('"server1"');
    await expect(controller.saveNow()).resolves.toBe(false);
    expect(calls[1]?.baseEtag).toBe('"server1"');
    expect(controller.getSnapshot().conflictEtag).toBe('"server2"');

    controller.setBaseEtag('"server2"');
    await expect(controller.saveNow()).resolves.toBe(true);
    expect(calls[2]?.baseEtag).toBe('"server2"');
    expect(controller.getSnapshot().status).toBe("saved");
    expect(calls.every((request) => request.baseEtag !== "*")).toBe(true);
  });

  it("blocks saves while an invalid form buffer is present", async () => {
    const save = vi.fn(() => Promise.resolve(accepted('"e2"')));
    const controller = setup(save);

    controller.setBlocked(true, "advanced schema JSON is invalid");
    controller.change(workflow("Blocked"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe("blocked");
    await expect(controller.saveNow()).resolves.toBe(false);

    controller.setBlocked(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("debounces content at 600 ms and layout-only at 5 s", async () => {
    const save = vi.fn(() => Promise.resolve(accepted('"e2"')));
    const controller = setup(save);

    controller.change(workflow("Layout"), { layoutOnly: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_400);
    expect(save).toHaveBeenCalledTimes(1);

    controller.change(workflow("Layout again"), { layoutOnly: true });
    await vi.advanceTimersByTimeAsync(300);
    controller.change(workflow("Content"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("saveNow during an in-flight autosave awaits the real operation, not a resolved placeholder", async () => {
    const pending = deferred<SaveOutcome>();
    const calls: SaveRequest[] = [];
    const save = vi.fn((request: SaveRequest) => {
      calls.push(request);
      return pending.promise;
    });
    const controller = setup(save);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.getSnapshot().status).toBe("saving");
    let settled = false;
    const explicit = controller.saveNow().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(calls).toHaveLength(1);

    pending.resolve(accepted('"e2"'));
    await expect(explicit).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("does not retry a failed in-flight save from saveNow", async () => {
    const pending = deferred<SaveOutcome>();
    const save = vi.fn(() => pending.promise);
    const controller = setup(save);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    const explicit = controller.saveNow();
    controller.setBlocked(true, "invalid JSON buffer");
    pending.resolve({ ok: false, kind: "error", message: "offline", code: "E_INTERNAL" });
    await expect(explicit).resolves.toBe(false);
    expect(save).toHaveBeenCalledTimes(1);

    await controller.retry();
    expect(controller.getSnapshot().status).toBe("blocked");
    expect(controller.getSnapshot().blocked).toBe(true);

    controller.setBlocked(false);
    expect(controller.getSnapshot().status).toBe("error");
  });

  it("keeps a block overlay after a successful in-flight ack", async () => {
    const pending = deferred<SaveOutcome>();
    const controller = setup(() => pending.promise);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    const explicit = controller.saveNow();
    controller.setBlocked(true, "invalid JSON buffer");
    pending.resolve(accepted('"e2"'));
    await expect(explicit).resolves.toBe(false);
    const blocked = controller.getSnapshot();
    expect(blocked.status).toBe("blocked");
    expect(blocked.savedRevision).toBe(1);
    expect(blocked.etag).toBe('"e2"');

    controller.setBlocked(false);
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("keeps conflict state while blocked and requires an explicit overwrite after unblock", async () => {
    const save = vi.fn(() =>
      Promise.resolve<SaveOutcome>({
        ok: false,
        kind: "conflict",
        message: "changed",
        currentEtag: '"server1"',
      }),
    );
    const controller = setup(save);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    controller.setBlocked(true, "invalid buffer");
    expect(controller.getSnapshot().status).toBe("blocked");
    controller.setBlocked(false);
    expect(controller.getSnapshot().status).toBe("conflict");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("reset clears a stale blocked flag", () => {
    const controller = setup(() => Promise.resolve(accepted('"e2"')));
    controller.setBlocked(true, "bad buffer");
    expect(controller.getSnapshot().blocked).toBe(true);
    controller.reset({ workflow: workflow("Fresh"), etag: '"fresh"' });
    expect(controller.getSnapshot().blocked).toBe(false);
    expect(controller.getSnapshot().status).toBe("clean");
  });

  it("saveNow waits for the serial queue to quiesce", async () => {
    const pending: ReturnType<typeof deferred<SaveOutcome>>[] = [];
    const calls: SaveRequest[] = [];
    const save = vi.fn((request: SaveRequest) => {
      calls.push(request);
      const next = deferred<SaveOutcome>();
      pending.push(next);
      return next.promise;
    });
    const controller = setup(save);

    controller.change(workflow("One"), { layoutOnly: false });
    await vi.advanceTimersByTimeAsync(600);
    const saving = controller.saveNow();
    controller.change(workflow("Two"), { layoutOnly: false });

    pending[0]?.resolve(accepted('"e2"'));
    await vi.advanceTimersByTimeAsync(0);
    pending[1]?.resolve(accepted('"e3"'));

    await expect(saving).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(controller.getSnapshot().revision).toBe(2);
    expect(controller.getSnapshot().savedRevision).toBe(2);
  });
});
