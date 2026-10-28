import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevChestraError,
  type ExecutionIdentity,
  FakeClock,
  FakeIdGen,
  type Path,
  type RunId,
} from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";

interface Harness {
  dir: string;
  store: Store;
  runId: RunId;
  close(): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-routing-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("r"),
  });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "routing",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    params: {},
    budgets: {},
  });
  const h: Harness = {
    dir,
    store,
    runId: run.runId,
    close: () => store.close(),
  };
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

function begin(h: Harness, nodeId: string, kind: "gate" | "join"): ExecutionIdentity {
  const path = nodeId as Path;
  h.store.executions.ensure({ runId: h.runId, path, nodeId, kind, requireSubmission: false });
  return h.store.executions.beginInvocation({
    runId: h.runId,
    path,
    attempt: 1,
    resolvedConfigHash: "cfg",
  });
}

function expectDevChestraError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DevChestraError);
    expect((error as DevChestraError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DevChestraError ${code}`);
}

describe("atomic routing commits", () => {
  it("commits gate output, decision and success together", () => {
    const h = harness();
    const identity = begin(h, "gate", "gate");
    const result = h.store.routing.recordGateDecision({
      identity,
      branch: "yes",
      evaluated: [
        { branch: "maybe", matched: false },
        { branch: "yes", matched: true },
      ],
    });

    expect(result.output?.json).toEqual({ branch: "yes" });
    expect(result.decisionEventId).not.toBeNull();
    expect(result.completionEventId).not.toBeNull();
    const view = h.store.view.get(h.runId);
    const exec = view.executions.gate;
    expect(exec?.status).toBe("succeeded");
    expect(exec?.gateDecision?.branch).toBe("yes");
    expect(h.store.events.list(h.runId).map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "node.state",
      "node.attempt.started",
      "node.state",
      "node.output.recorded",
      "gate.decided",
      "node.state",
    ]);
  });

  it("records a failed gate decision without writing a success output", () => {
    const h = harness();
    const identity = begin(h, "gate", "gate");
    const result = h.store.routing.recordGateDecision({
      identity,
      branch: null,
      evaluated: [{ branch: "yes", matched: false, error: "E_EXPR" }],
    });
    expect(result.output).toBeNull();
    expect(result.completionEventId).toBeNull();
    const exec = h.store.view.get(h.runId).executions.gate;
    expect(exec?.status).toBe("running");
    expect(exec?.gateDecision?.branch).toBeNull();
    expect(h.store.outputs.get(identity)).toBeNull();
  });

  it("commits an all-join output and resolution", () => {
    const h = harness();
    const identity = begin(h, "join", "join");
    const result = h.store.routing.recordJoinResolution({
      identity,
      mode: "all",
      active: ["left"],
      skipped: ["right"],
      output: { left: { value: 1 }, right: null },
    });
    expect(result.output?.json).toEqual({ left: { value: 1 }, right: null });
    const exec = h.store.view.get(h.runId).executions.join;
    expect(exec?.status).toBe("succeeded");
    expect(exec?.joinResolution).toEqual({
      mode: "all",
      active: ["left"],
      skipped: ["right"],
      attempt: 1,
      generation: 2,
    });
  });

  it("rejects a first-join conflict without partial writes", () => {
    const h = harness();
    const identity = begin(h, "join", "join");
    const before = h.store.events.list(h.runId).length;
    expectDevChestraError(
      () =>
        h.store.routing.recordJoinResolution({
          identity,
          mode: "first",
          active: ["left", "right"],
          skipped: [],
          output: { value: 1 },
        }),
      "E_JOIN_CONFLICT",
    );
    expect(h.store.events.list(h.runId).length).toBe(before);
    expect(h.store.outputs.get(identity)).toBeNull();
    expect(h.store.view.get(h.runId).executions.join?.status).toBe("running");
  });

  it("rejects a contradictory successful gate trace", () => {
    const h = harness();
    const identity = begin(h, "gate", "gate");
    expectDevChestraError(
      () =>
        h.store.routing.recordGateDecision({
          identity,
          branch: "yes",
          evaluated: [
            { branch: "yes", matched: true },
            { branch: "no", matched: true },
          ],
        }),
      "E_VALIDATION",
    );
    expect(h.store.outputs.get(identity)).toBeNull();
  });

  it("rolls the whole gate commit back when the outer transaction fails", () => {
    const h = harness();
    const identity = begin(h, "gate", "gate");
    const before = h.store.events.list(h.runId).length;
    expect(() =>
      h.store.tx(() => {
        h.store.routing.recordGateDecision({
          identity,
          branch: "yes",
          evaluated: [{ branch: "yes", matched: true }],
        });
        throw new Error("outer failure");
      }),
    ).toThrow("outer failure");
    expect(h.store.events.list(h.runId).length).toBe(before);
    expect(h.store.outputs.get(identity)).toBeNull();
    expect(h.store.view.get(h.runId).executions.gate?.gateDecision).toBeNull();
    expect(h.store.view.get(h.runId).executions.gate?.status).toBe("running");
  });

  it("rebuilds routing from replay and does not duplicate a completed route", () => {
    const h = harness();
    const identity = begin(h, "gate", "gate");
    h.store.routing.recordGateDecision({
      identity,
      branch: "yes",
      evaluated: [{ branch: "yes", matched: true }],
    });
    const before = h.store.events.list(h.runId).length;
    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt.executions.gate?.gateDecision?.branch).toBe("yes");
    expect(rebuilt.executions.gate?.status).toBe("succeeded");

    const duplicate = h.store.routing.recordGateDecision({
      identity,
      branch: "yes",
      evaluated: [{ branch: "yes", matched: true }],
    });
    expect(duplicate.duplicate).toBe(true);
    expect(h.store.events.list(h.runId).length).toBe(before);
  });

  it("fences a late callback from another logical attempt", () => {
    const h = harness();
    const identity = begin(h, "gate", "gate");
    h.store.routing.recordGateDecision({
      identity,
      branch: "yes",
      evaluated: [{ branch: "yes", matched: true }],
    });
    const before = h.store.events.list(h.runId).length;
    expectDevChestraError(
      () =>
        h.store.routing.recordGateDecision({
          identity: { ...identity, attempt: 2 },
          branch: "no",
          evaluated: [{ branch: "no", matched: true }],
        }),
      "E_CONFLICT",
    );
    expect(h.store.events.list(h.runId).length).toBe(before);
  });
});
