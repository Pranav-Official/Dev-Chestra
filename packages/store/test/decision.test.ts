import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionIdentity,
  FakeClock,
  FakeIdGen,
  type Path,
  RelayError,
  type RunId,
} from "@relay/core";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordDecisionInput } from "../src/index.js";
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
  const dir = mkdtempSync(join(tmpdir(), "relay-decision-"));
  const store = openStore({
    file: join(dir, "relay.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("r"),
  });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "decision",
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

function begin(h: Harness, nodeId: string): ExecutionIdentity {
  const path = nodeId as Path;
  h.store.executions.ensure({
    runId: h.runId,
    path,
    nodeId,
    kind: "decision",
    requireSubmission: false,
  });
  return h.store.executions.beginInvocation({
    runId: h.runId,
    path,
    attempt: 1,
    resolvedConfigHash: "cfg",
  });
}

function expectRelayError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected RelayError ${code}`);
}

function decisionInput(
  identity: ExecutionIdentity,
  overrides: Partial<RecordDecisionInput> = {},
): RecordDecisionInput {
  return {
    identity,
    provider: "typesafe-jev",
    model: "jev-latest",
    questionIds: ["q0"],
    output: {
      kind: "boolean",
      value: true,
      probability: 0.8,
      confidence: 0.8,
      confidenceSource: "derived",
      model: "jev-latest",
    },
    routing: { branch: "true", reason: "matched" },
    ...overrides,
  };
}

describe("decision commits", () => {
  it("commits output, events and success together", () => {
    const h = harness();
    const identity = begin(h, "decide");
    const result = h.store.routing.recordDecision(decisionInput(identity));

    expect(result.output?.json).toEqual({ branch: "true" });
    expect(result.decisionEventId).not.toBeNull();
    expect(result.completionEventId).not.toBeNull();
    const view = h.store.view.get(h.runId);
    const exec = view.executions.decide;
    expect(exec?.status).toBe("succeeded");
    expect(exec?.decision?.routing).toEqual({ branch: "true", reason: "matched" });
    expect(exec?.decision?.output).toMatchObject({ kind: "boolean", value: true });
    expect(h.store.events.list(h.runId).map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "node.state",
      "node.attempt.started",
      "node.state",
      "decision.requested",
      "decision.answered",
      "node.output.recorded",
      "node.state",
    ]);
    const requested = h.store.events.list(h.runId).find((e) => e.type === "decision.requested");
    expect(requested?.payload).toMatchObject({
      provider: "typesafe-jev",
      model: "jev-latest",
      questionIds: ["q0"],
      attempt: 1,
      generation: identity.generation,
    });
  });

  it("records an uncertain branch as a success with the uncertain branch output", () => {
    const h = harness();
    const identity = begin(h, "decide");
    const result = h.store.routing.recordDecision(
      decisionInput(identity, {
        output: {
          kind: "choice",
          value: null,
          confidence: null,
          confidenceSource: null,
          model: "clef",
          refusal: {},
        },
        routing: { branch: "uncertain", reason: "refused" },
      }),
    );
    expect(result.output?.json).toEqual({ branch: "uncertain" });
    expect(result.completionEventId).not.toBeNull();
    expect(h.store.view.get(h.runId).executions.decide?.decision?.routing).toEqual({
      branch: "uncertain",
      reason: "refused",
    });
  });

  it("appends events without output or completion for a null branch", () => {
    const h = harness();
    const identity = begin(h, "decide");
    const result = h.store.routing.recordDecision(
      decisionInput(identity, {
        output: {
          kind: "score",
          value: null,
          confidence: null,
          confidenceSource: null,
          model: "clef",
        },
        routing: { branch: null, reason: "error" },
      }),
    );
    expect(result.output).toBeNull();
    expect(result.completionEventId).toBeNull();
    const exec = h.store.view.get(h.runId).executions.decide;
    expect(exec?.status).toBe("running");
    expect(exec?.decision?.routing.branch).toBeNull();
    expect(h.store.outputs.get(identity)).toBeNull();
  });

  it("rejects malformed output and reason codes without partial writes", () => {
    const h = harness();
    const identity = begin(h, "decide");
    const before = h.store.events.list(h.runId).length;
    expectRelayError(
      () => h.store.routing.recordDecision(decisionInput(identity, { output: { kind: "nope" } })),
      "E_VALIDATION",
    );
    expectRelayError(
      () =>
        h.store.routing.recordDecision(
          decisionInput(identity, { routing: { branch: "true", reason: "bogus" } }),
        ),
      "E_VALIDATION",
    );
    expect(h.store.events.list(h.runId).length).toBe(before);
    expect(h.store.outputs.get(identity)).toBeNull();
    expect(h.store.view.get(h.runId).executions.decide?.decision).toBeNull();
  });

  it("rebuilds the projection from replay and treats a repeat as duplicate", () => {
    const h = harness();
    const identity = begin(h, "decide");
    h.store.routing.recordDecision(decisionInput(identity));
    const before = h.store.events.list(h.runId).length;
    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt.executions.decide?.decision?.routing.branch).toBe("true");
    expect(rebuilt.executions.decide?.status).toBe("succeeded");

    const duplicate = h.store.routing.recordDecision(decisionInput(identity));
    expect(duplicate.duplicate).toBe(true);
    expect(h.store.events.list(h.runId).length).toBe(before);
  });

  it("fences a late callback from another logical attempt", () => {
    const h = harness();
    const identity = begin(h, "decide");
    h.store.routing.recordDecision(decisionInput(identity));
    const before = h.store.events.list(h.runId).length;
    expectRelayError(
      () =>
        h.store.routing.recordDecision(
          decisionInput(
            { ...identity, attempt: 2 },
            { routing: { branch: "false", reason: "matched" } },
          ),
        ),
      "E_CONFLICT",
    );
    expect(h.store.events.list(h.runId).length).toBe(before);
  });
});
