import * as fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptedInvocation,
  canTransition,
  type EventEnvelope,
  type ExecStatus,
  type ExecView,
  emptyRunView,
  formatPath,
  isDurablyComplete,
  type NodeId,
  type NodeStateInit,
  type Path,
  project,
  RelayError,
  type RunView,
  recoveryDecision,
  reduce,
} from "../src/index.js";
import { AGENT_PATH, ev, nodePath, RUN_ID, RUN_PATH, resetEventIds } from "./helpers.js";

const KEY = AGENT_PATH as string;

function created(runNumber = 1): EventEnvelope<"run.created"> {
  return ev(
    "run.created",
    {
      workflowId: "linear",
      workflowHash: "workflow-hash",
      runNumber,
      params: {},
      budgets: {},
      kind: "run",
    },
    { path: RUN_PATH, actor: "user" },
  );
}

function started(): EventEnvelope<"run.started"> {
  return ev("run.started", {}, { path: RUN_PATH });
}

function state(
  from: ExecStatus,
  to: ExecStatus,
  init?: NodeStateInit,
  attempt = 1,
  generation = 1,
  path: Path = AGENT_PATH,
): EventEnvelope<"node.state"> {
  return ev(
    "node.state",
    init === undefined
      ? { from, to, attempt, generation }
      : { from, to, attempt, generation, init },
    { path },
  );
}

function attemptStarted(
  attempt = 1,
  generation = 1,
  mode: "fresh" | "resume" = "fresh",
): EventEnvelope<"node.attempt.started"> {
  return ev("node.attempt.started", {
    attempt,
    generation,
    mode,
    resolvedConfigHash: "config-hash",
    nodeKind: "agent",
    requireSubmission: true,
  });
}

function validated(
  outputId = "out-1",
  attempt = 1,
  generation = 1,
): EventEnvelope<"node.output.validated"> {
  return ev("node.output.validated", {
    attempt,
    generation,
    outputId,
    outputHash: `hash-${outputId}`,
    schemaHash: "schema-hash",
  });
}

function stopped(
  attempt = 1,
  generation = 1,
  path: Path = AGENT_PATH,
  reason: "exited" | "killed" | "grace_timeout" | "crash" = "exited",
): EventEnvelope<"node.process.stopped"> {
  return ev(
    "node.process.stopped",
    {
      attempt,
      generation,
      reason,
      exitCode: reason === "crash" ? null : 0,
    },
    { path },
  );
}

function finalized(
  attempt = 1,
  generation = 1,
  path: Path = AGENT_PATH,
): EventEnvelope<"node.workspace.finalized"> {
  return ev(
    "node.workspace.finalized",
    {
      attempt,
      generation,
      dir: "/tmp/ws",
      commitSha: "abc123",
    },
    { path },
  );
}

function recorded(
  outputId = "recorded-1",
  attempt = 1,
  generation = 1,
  path: Path = AGENT_PATH,
): EventEnvelope<"node.output.recorded"> {
  return ev(
    "node.output.recorded",
    { attempt, generation, outputId, outputHash: `hash-${outputId}` },
    { path },
  );
}

function spawned(
  attempt = 1,
  generation = 1,
  pid = 4321,
  path: Path = AGENT_PATH,
): EventEnvelope<"node.process.spawned"> {
  return ev(
    "node.process.spawned",
    {
      attempt,
      generation,
      pid,
      pidStart: "start-token",
      binary: "/usr/bin/fake-agent",
      cwd: "/tmp/ws",
    },
    { path },
  );
}

function base(): EventEnvelope[] {
  return [
    created(),
    started(),
    state("pending", "ready", { kind: "agent", requireSubmission: true }),
    state("ready", "running"),
    attemptStarted(),
  ];
}

function accepted(): EventEnvelope[] {
  return [...base(), validated()];
}

function durable(): EventEnvelope[] {
  return [...accepted(), stopped(), finalized()];
}

function completed(status: "success" | "failed" | "rejected" | "cancelled") {
  return ev("run.completed", { status, endPath: AGENT_PATH }, { path: RUN_PATH });
}

function workspaceCreated(
  dir: string,
  attempt = 1,
  generation = 1,
  path: Path = AGENT_PATH,
): EventEnvelope<"workspace.created"> {
  return ev(
    "workspace.created",
    { attempt, generation, mode: "scratch", dir, branch: "relay/work" },
    { path },
  );
}

function workspaceCommitted(
  sha: string,
  attempt = 1,
  generation = 1,
  path: Path = AGENT_PATH,
): EventEnvelope<"workspace.committed"> {
  return ev(
    "workspace.committed",
    { attempt, generation, sha, filesChanged: 1, insertions: 2, deletions: 3 },
    { path },
  );
}

function execWithStatus(status: ExecStatus): ExecView {
  return {
    path: AGENT_PATH,
    nodeId: "agent",
    status,
    attempt: 1,
    generation: 1,
    kind: "agent",
    gateDecision: null,
    joinResolution: null,
    approvalRequest: null,
    approvalDecision: null,
    decision: null,
    requiresAcceptedResult: false,
    acceptedResult: null,
    recordedOutput: null,
    processSpawned: null,
    processStopped: null,
    workspaceFinalized: null,
    validationAttempts: 0,
    crashAttempts: 0,
    mode: null,
    cli: null,
    sessionId: null,
    sessionCwd: null,
    model: null,
    resolvedConfigHash: null,
    inputsHash: null,
    startedAt: null,
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    attemptTokensIn: 0,
    attemptTokensOut: 0,
    attemptCostUsd: 0,
    workspaceDir: null,
    branch: null,
    workspaceCommitted: null,
    lastValidationErrors: [],
    lastTranscript: null,
    lastError: null,
  };
}

beforeEach(() => {
  resetEventIds();
});

describe("run and execution projection", () => {
  it("starts from an empty view", () => {
    expect(project([])).toEqual(emptyRunView());
    expect(project([]).status).toBe("queued");
    expect(project([]).lastEventId).toBe(0);
  });

  it("projects the run lifecycle and run number", () => {
    const view = project([created(7), started()]);
    expect(view.runNumber).toBe(7);
    expect(view.status).toBe("running");
    expect(view.activeSince).not.toBeNull();
  });

  it("records named pause metadata for uncertain side effects and clears it on resume", () => {
    const paused = project([
      created(),
      started(),
      ev(
        "run.paused",
        {
          reason: "uncertain_side_effect",
          detail: "shell may have executed",
          path: AGENT_PATH,
        },
        { path: RUN_PATH },
      ),
    ]);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("uncertain_side_effect");
    expect(paused.pauseDetail).toBe("shell may have executed");
    expect(paused.pausePath).toBe(AGENT_PATH);

    const resumed = reduce(paused, ev("run.resumed", { reason: "user" }, { path: RUN_PATH }));
    expect(resumed.status).toBe("running");
    expect(resumed.pauseReason).toBeNull();
    expect(resumed.pauseDetail).toBeNull();
    expect(resumed.pausePath).toBeNull();
  });

  it("projects node state, session, inputs, usage and transcript refs", () => {
    const events = [
      ...base(),
      ev("node.session.captured", {
        attempt: 1,
        generation: 1,
        cli: "fake",
        sessionId: "session-1",
        cwd: "/tmp/ws",
        model: "fake-model",
      }),
      ev("node.input.resolved", {
        attempt: 1,
        generation: 1,
        inputsHash: "inputs-hash",
        inputs: { prompt: "hello" },
      }),
      ev("node.usage", {
        attempt: 1,
        generation: 1,
        tokensIn: 10,
        tokensOut: 4,
        costUsd: 0.25,
        costSource: "reported",
      }),
      ev("node.transcript.ref", {
        attempt: 1,
        generation: 1,
        file: "transcript.jsonl",
        bytes: 128,
      }),
    ];
    const view = project(events);
    const exec = view.executions[KEY];
    expect(exec?.sessionId).toBe("session-1");
    expect(exec?.inputsHash).toBe("inputs-hash");
    expect(exec?.tokensIn).toBe(10);
    expect(exec?.tokensOut).toBe(4);
    expect(exec?.costUsd).toBe(0.25);
    expect(exec?.lastTranscript).toEqual({ file: "transcript.jsonl", bytes: 128 });
    expect(view.budget).toEqual({
      usd: 0.25,
      tokens: 14,
      activeMs: 0,
      supervisorUsd: 0,
    });
  });
});

describe("durable lifecycle: accepted is not succeeded", () => {
  it("accepts a result into validating without succeeding", () => {
    const view = project(accepted());
    const exec = view.executions[KEY];
    expect(exec?.status).toBe("validating");
    expect(exec?.acceptedResult).toMatchObject({
      outputId: "out-1",
      attempt: 1,
      generation: 1,
    });
    expect(exec?.acceptedResult?.acceptedEventId).toBeGreaterThan(0);
    expect(isDurablyComplete(exec as NonNullable<typeof exec>)).toBe(false);
    expect(view.status).toBe("running");
  });

  it("refuses success before process stop and workspace finalization", () => {
    const view = project(accepted());
    expect(() => reduce(view, state("validating", "succeeded"))).toThrow(RelayError);
    expect(() => reduce(view, state("validating", "succeeded"))).toThrow(
      /process stop and workspace finalization/,
    );
  });

  it("succeeds only after accepted result, stop and finalization agree", () => {
    const view = project(durable());
    const done = reduce(view, state("validating", "succeeded"));
    expect(done.executions[KEY]?.status).toBe("succeeded");
    expect(done.executions[KEY]?.endedAt).not.toBeNull();

    const run = reduce(done, completed("success"));
    expect(run.status).toBe("succeeded");
  });

  it("rejects successful completion while any execution is pending or active", () => {
    const active: ExecStatus[] = [
      "pending",
      "ready",
      "running",
      "validating",
      "waiting_approval",
      "waiting_quota",
      "interrupted",
    ];
    fc.assert(
      fc.property(fc.constantFrom(...active), (status) => {
        const view: RunView = {
          ...emptyRunView(),
          status: "running",
          runNumber: 1,
          executions: { [KEY]: execWithStatus(status) },
          lastEventId: 100,
        };
        const completion = ev("run.completed", { status: "success" }, { path: RUN_PATH, id: 101 });
        try {
          reduce(view, completion);
          return false;
        } catch (error) {
          return error instanceof RelayError && error.code === "E_INTERNAL";
        }
      }),
    );
  });

  it("requires an accepted result for an execution marked requireSubmission", () => {
    const view = project(base());
    expect(() => reduce(view, state("running", "succeeded"))).toThrow(
      /cannot succeed without an accepted result/,
    );
  });

  it("allows start/end success with only a recorded deterministic output", () => {
    for (const kind of ["start", "end"] as const) {
      const nodePath = formatPath([{ node: kind as NodeId }]);
      const events = [
        created(),
        started(),
        state("pending", "ready", { kind, requireSubmission: false }, 1, 1, nodePath),
        state("ready", "running", undefined, 1, 1, nodePath),
        recorded("out-1", 1, 1, nodePath),
        state("running", "succeeded", undefined, 1, 1, nodePath),
      ];
      const view = project(events);
      expect(view.executions[nodePath as string]?.status).toBe("succeeded");
      expect(view.executions[nodePath as string]?.recordedOutput?.outputId).toBe("out-1");
      expect(reduce(view, completed("success")).status).toBe("succeeded");
    }
  });

  it("requires deterministic output for start/end", () => {
    const startPath = formatPath([{ node: "start" as NodeId }]);
    const view = project([
      created(),
      started(),
      state("pending", "ready", { kind: "start", requireSubmission: false }, 1, 1, startPath),
      state("ready", "running", undefined, 1, 1, startPath),
    ]);
    expect(() => reduce(view, state("running", "succeeded", undefined, 1, 1, startPath))).toThrow(
      /Non-agent execution cannot succeed/,
    );
  });

  it("requires recorded output, process stop and workspace finalization for shell", () => {
    const shellPath = formatPath([{ node: "shell" as NodeId }]);
    let view = project([
      created(),
      started(),
      state("pending", "ready", { kind: "shell", requireSubmission: false }, 1, 1, shellPath),
      state("ready", "running", undefined, 1, 1, shellPath),
    ]);
    expect(() => reduce(view, state("running", "succeeded", undefined, 1, 1, shellPath))).toThrow(
      /Non-agent execution cannot succeed/,
    );
    view = reduce(view, recorded("out-1", 1, 1, shellPath));
    expect(() => reduce(view, state("running", "succeeded", undefined, 1, 1, shellPath))).toThrow(
      /Non-agent execution cannot succeed/,
    );
    view = reduce(view, stopped(1, 1, shellPath));
    expect(() => reduce(view, state("running", "succeeded", undefined, 1, 1, shellPath))).toThrow(
      /Non-agent execution cannot succeed/,
    );
    view = reduce(view, finalized(1, 1, shellPath));
    const done = reduce(view, state("running", "succeeded", undefined, 1, 1, shellPath));
    expect(done.executions[shellPath as string]?.status).toBe("succeeded");
  });

  it("never treats a conflicting second accepted result as success", () => {
    const view = project(accepted());
    expect(() => reduce(view, validated("out-2"))).toThrow(/immutable/);
  });

  it("refuses a successful run while an accepted result is not succeeded", () => {
    const view = project(durable());
    expect(view.executions[KEY]?.status).toBe("validating");
    try {
      reduce(view, completed("success"));
      expect.unreachable("successful run completion should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect(error).toMatchObject({ code: "E_INTERNAL" });
    }
  });

  it("finalizes an accepted invocation without starting a new generation", () => {
    const acceptedView = project(durable());
    const exec = acceptedView.executions[KEY];
    expect(exec).toBeDefined();
    expect(recoveryDecision(exec as NonNullable<typeof exec>)).toEqual({
      action: "mark_succeeded",
      from: "validating",
      to: "succeeded",
    });
    expect(isDurablyComplete(exec as NonNullable<typeof exec>)).toBe(true);
    if (exec?.acceptedResult === null || exec?.acceptedResult === undefined) {
      throw new Error("expected an accepted result");
    }
    expect(acceptedInvocation(exec.acceptedResult)).toEqual({
      runId: RUN_ID,
      path: AGENT_PATH,
      attempt: 1,
      generation: 1,
    });

    expect(isDurablyComplete({ ...(exec as ExecView), generation: 2 })).toBe(false);
    expect(() => reduce(acceptedView, attemptStarted(1, 2, "resume"))).toThrow(
      /Accepted result must be finalized without starting a new process generation/,
    );
  });
});

describe("validation counters, fencing and replay", () => {
  it("persists the validation counter without double counting replays", () => {
    const baseEvents = base();
    const first = ev("node.output.rejected", {
      attempt: 1,
      generation: 1,
      validationAttempt: 1,
      errors: [{ path: "name", message: "Required" }],
    });
    const second = ev("node.output.rejected", {
      attempt: 1,
      generation: 1,
      validationAttempt: 2,
      errors: [{ path: "name", message: "Still required" }],
    });
    const events = [...baseEvents, first, second];
    const view = project(events);
    expect(view.executions[KEY]?.validationAttempts).toBe(2);
    expect(view.executions[KEY]?.lastValidationErrors).toEqual(second.payload.errors);

    const replay = project(events);
    expect(replay.executions[KEY]?.validationAttempts).toBe(2);
  });

  it("rejects callbacks from an older process generation", () => {
    const view = project([...base(), attemptStarted(1, 2, "fresh")]);
    expect(view.executions[KEY]?.generation).toBe(2);
    expect(() => reduce(view, validated("out-old", 1, 1))).toThrow(/fenced/);
  });

  it("rejects a future generation unless attempt.started advanced it", () => {
    const view = project(base());
    expect(() =>
      reduce(
        view,
        ev("node.output.validated", {
          attempt: 1,
          generation: 2,
          outputId: "out-future",
          outputHash: "hash",
        }),
      ),
    ).toThrow(/fenced/);
  });

  it("ignores duplicate or older event ids", () => {
    const events = accepted();
    const once = project(events);
    const last = events.at(-1);
    expect(last).toBeDefined();
    const twice = reduce(once, last as EventEnvelope);
    expect(twice).toEqual(once);
    expect(reduce(once, events[0] as EventEnvelope)).toBe(once);
  });

  it("ignores unknown event types and known types with a future payload version", () => {
    const view = project(base());
    const unknown: EventEnvelope = {
      id: 10_000,
      runId: RUN_ID,
      ts: new Date().toISOString(),
      path: AGENT_PATH,
      type: "future.event",
      actor: "engine",
      v: 1,
      payload: { anything: true },
    };
    const ignored = reduce(view, unknown);
    expect(ignored.lastEventId).toBe(10_000);
    expect({ ...ignored, lastEventId: view.lastEventId }).toEqual(view);

    const futureVersion = ev(
      "node.state",
      { from: "running", to: "failed", attempt: 1, generation: 1 },
      { v: 2 },
    );
    const versioned = reduce(view, futureVersion);
    expect(versioned.executions[KEY]?.status).toBe("running");
    expect(versioned.lastEventId).toBe(futureVersion.id);
  });

  it("replays to the same projection through a checkpoint", () => {
    const events = [...durable(), state("validating", "succeeded"), completed("success")];
    const full = project(events);
    const checkpoint = project(events.slice(0, 5));
    const resumed = events.slice(5).reduce((view, event) => reduce(view, event), checkpoint);
    expect(resumed).toEqual(full);
    expect(full.executions[KEY]?.status).toBe("succeeded");
    expect(full.status).toBe("succeeded");
  });
});

describe("process and deterministic output evidence", () => {
  it("records fenced process spawn evidence and rejects conflicts", () => {
    const view = project([...base(), spawned()]);
    expect(view.executions[KEY]?.processSpawned).toMatchObject({
      attempt: 1,
      generation: 1,
      pid: 4321,
      pidStart: "start-token",
      binary: "/usr/bin/fake-agent",
      cwd: "/tmp/ws",
    });

    const duplicate = reduce(view, spawned());
    expect(duplicate.executions[KEY]?.processSpawned).toEqual(view.executions[KEY]?.processSpawned);
    expect(() => reduce(view, spawned(1, 1, 999))).toThrow(/already recorded differently/);
    expect(() => reduce(view, spawned(1, 1, 0))).toThrow(/Invalid process pid/);

    const gen2 = reduce(view, attemptStarted(1, 2, "fresh"));
    expect(gen2.executions[KEY]?.processSpawned).toBeNull();
    expect(() => reduce(gen2, spawned(1, 1))).toThrow(/fenced/);
    expect(() =>
      reduce(
        view,
        ev(
          "node.process.spawned",
          {
            attempt: 1,
            generation: 1,
            pid: 123,
            pidStart: "start",
            binary: "/bin/sh",
            cwd: "",
          },
          { path: AGENT_PATH },
        ),
      ),
    ).toThrow(/Invalid process cwd/);
  });

  it("records one immutable deterministic output per attempt", () => {
    const view = project([...base(), recorded("rec-1")]);
    expect(view.executions[KEY]?.recordedOutput).toMatchObject({
      outputId: "rec-1",
      attempt: 1,
      generation: 1,
    });
    expect(view.executions[KEY]?.acceptedResult).toBeNull();

    const duplicate = reduce(view, recorded("rec-1"));
    expect(duplicate.executions[KEY]?.recordedOutput?.outputId).toBe("rec-1");
    expect(() => reduce(view, recorded("rec-2"))).toThrow(/immutable/);

    const gen2 = reduce(view, attemptStarted(1, 2, "fresh"));
    expect(gen2.executions[KEY]?.recordedOutput).toBeNull();
    expect(() => reduce(gen2, recorded("rec-1", 1, 1))).toThrow(/fenced/);
  });

  it("counts a crash once per generation and retains the budget across generations", () => {
    let view = project([...base(), stopped(1, 1, AGENT_PATH, "crash")]);
    expect(view.executions[KEY]?.crashAttempts).toBe(1);
    view = reduce(view, stopped(1, 1, AGENT_PATH, "crash"));
    expect(view.executions[KEY]?.crashAttempts).toBe(1);

    view = reduce(view, attemptStarted(1, 2, "resume"));
    expect(view.executions[KEY]?.generation).toBe(2);
    expect(view.executions[KEY]?.crashAttempts).toBe(1);
    expect(view.executions[KEY]?.processStopped).toBeNull();

    view = reduce(view, stopped(1, 2, AGENT_PATH, "crash"));
    expect(view.executions[KEY]?.crashAttempts).toBe(2);
  });
});

describe("attempt retry provenance", () => {
  it("clears stale per-attempt state while retaining cumulative usage", () => {
    const shellPath = formatPath([{ node: "shell" as NodeId }]);
    const events = [
      created(),
      started(),
      state("pending", "ready", { kind: "shell", requireSubmission: false }, 1, 1, shellPath),
      state("ready", "running", undefined, 1, 1, shellPath),
      ev(
        "node.attempt.started",
        {
          attempt: 1,
          generation: 1,
          mode: "fresh",
          resolvedConfigHash: "config-hash",
          nodeKind: "shell",
          requireSubmission: false,
        },
        { path: shellPath },
      ),
      ev(
        "node.session.captured",
        {
          attempt: 1,
          generation: 1,
          cli: "fake",
          sessionId: "session-1",
          cwd: "/tmp/ws",
          model: "fake-model",
        },
        { path: shellPath },
      ),
      ev(
        "node.usage",
        {
          attempt: 1,
          generation: 1,
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.1,
          costSource: "reported",
        },
        { path: shellPath },
      ),
      workspaceCreated("/tmp/ws", 1, 1, shellPath),
      workspaceCommitted("abc", 1, 1, shellPath),
      ev(
        "node.transcript.ref",
        { attempt: 1, generation: 1, file: "t.jsonl", bytes: 10 },
        { path: shellPath },
      ),
      ev("error.logged", { code: "E_WORKSPACE", message: "boom" }, { path: shellPath }),
      recorded("out-shell", 1, 1, shellPath),
      stopped(1, 1, shellPath),
      finalized(1, 1, shellPath),
      state("running", "succeeded", undefined, 1, 1, shellPath),
      state("succeeded", "pending", undefined, 2, 1, shellPath),
    ];
    const exec = project(events).executions[shellPath as string];
    expect(exec?.status).toBe("pending");
    expect(exec?.attempt).toBe(2);
    expect(exec?.sessionId).toBeNull();
    expect(exec?.sessionCwd).toBeNull();
    expect(exec?.cli).toBeNull();
    expect(exec?.model).toBeNull();
    expect(exec?.resolvedConfigHash).toBeNull();
    expect(exec?.workspaceDir).toBeNull();
    expect(exec?.branch).toBeNull();
    expect(exec?.workspaceCommitted).toBeNull();
    expect(exec?.lastError).toBeNull();
    expect(exec?.lastTranscript).toBeNull();
    expect(exec?.acceptedResult).toBeNull();
    expect(exec?.recordedOutput).toBeNull();
    expect(exec?.processSpawned).toBeNull();
    expect(exec?.processStopped).toBeNull();
    expect(exec?.workspaceFinalized).toBeNull();
    expect(exec?.validationAttempts).toBe(0);
    expect(exec?.attemptTokensIn).toBe(0);
    expect(exec?.attemptTokensOut).toBe(0);
    expect(exec?.attemptCostUsd).toBe(0);
    expect(exec?.tokensIn).toBe(10);
    expect(exec?.tokensOut).toBe(5);
    expect(exec?.costUsd).toBe(0.1);
  });

  it("fences workspace events from a previous attempt or generation", () => {
    const view = project([...base(), workspaceCreated("ws-1"), workspaceCommitted("sha-1")]);
    expect(view.executions[KEY]?.workspaceDir).toBe("ws-1");
    expect(view.executions[KEY]?.workspaceCommitted?.sha).toBe("sha-1");

    const gen2 = reduce(view, attemptStarted(1, 2, "fresh"));
    expect(gen2.executions[KEY]?.generation).toBe(2);
    expect(() => reduce(gen2, workspaceCreated("ws-old", 1, 1))).toThrow(/fenced/);
    expect(() => reduce(gen2, workspaceCommitted("sha-old", 1, 1))).toThrow(/fenced/);

    const live = reduce(gen2, workspaceCreated("ws-2", 1, 2));
    expect(live.executions[KEY]?.workspaceDir).toBe("ws-2");
  });
});

describe("recovery decisions are legal transitions", () => {
  const cases: [string, EventEnvelope[], ExecStatus, ExecStatus][] = [
    ["unaccepted running", base(), "running", "interrupted"],
    ["accepted durable validating", durable(), "validating", "succeeded"],
  ];

  for (const [name, events, expectedFrom, expectedTo] of cases) {
    it(name, () => {
      const exec = project(events).executions[KEY];
      expect(exec).toBeDefined();
      const decision = recoveryDecision(exec as NonNullable<typeof exec>);
      expect(decision.from).toBe(expectedFrom);
      expect(decision.to).toBe(expectedTo);
      expect(canTransition(decision.from, decision.to)).toBe(true);
    });
  }

  it("moves interrupted executions back to ready", () => {
    const interrupted = reduce(project(base()), state("running", "interrupted"));
    const exec = interrupted.executions[KEY];
    expect(exec).toBeDefined();
    const decision = recoveryDecision(exec as NonNullable<typeof exec>);
    expect(decision).toEqual({ action: "make_ready", from: "interrupted", to: "ready" });
    expect(canTransition(decision.from, decision.to)).toBe(true);
  });
});

describe("routing projection", () => {
  const gatePath = nodePath("gate");
  const gateKey = gatePath as string;

  function runningNode(path: Path, nodeKind: "gate" | "join"): EventEnvelope[] {
    return [
      state("pending", "ready", { kind: nodeKind, requireSubmission: false }, 1, 1, path),
      state("ready", "running", undefined, 1, 1, path),
    ];
  }

  function routed(events: EventEnvelope[]): RunView {
    return events.reduce((view, event) => reduce(view, event), emptyRunView());
  }

  it("projects a durable gate decision and fences it by invocation", () => {
    const running = runningNode(gatePath, "gate");
    const decided = ev(
      "gate.decided",
      {
        branch: "yes",
        evaluated: [{ branch: "yes", matched: true }],
        attempt: 1,
        generation: 1,
      },
      { path: gatePath },
    );
    const view = routed([...running, decided]);
    expect(view.executions[gateKey]?.gateDecision).toEqual({
      branch: "yes",
      evaluated: [{ branch: "yes", matched: true }],
      attempt: 1,
      generation: 1,
    });

    const stale = ev(
      "gate.decided",
      { branch: "no", evaluated: [{ branch: "no", matched: true }], attempt: 2, generation: 1 },
      { path: gatePath },
    );
    expect(() => reduce(view, stale)).toThrow(RelayError);
  });

  it("rejects a second conflicting decision", () => {
    const running = runningNode(gatePath, "gate");
    const decided = ev(
      "gate.decided",
      { branch: "yes", evaluated: [{ branch: "yes", matched: true }] },
      { path: gatePath },
    );
    const view = routed([...running, decided]);
    const again = ev(
      "gate.decided",
      { branch: "no", evaluated: [{ branch: "no", matched: true }] },
      { path: gatePath },
    );
    expect(() => reduce(view, again)).toThrow(RelayError);
  });

  it("projects join inputs and resets routing metadata on retries and generations", () => {
    const joinPath = nodePath("join");
    const joinRunning = runningNode(joinPath, "join");
    const resolved = ev(
      "join.resolved",
      { mode: "all", active: ["a"], skipped: ["b"], attempt: 1, generation: 1 },
      { path: joinPath },
    );
    const view = routed([...joinRunning, resolved]);
    expect(view.executions[joinPath]?.joinResolution).toEqual({
      mode: "all",
      active: ["a"],
      skipped: ["b"],
      attempt: 1,
      generation: 1,
    });

    const done = state("running", "succeeded", undefined, 1, 1, joinPath);
    const retry = state(
      "succeeded",
      "pending",
      { kind: "join", requireSubmission: false },
      2,
      1,
      joinPath,
    );
    const retried = reduce(reduce(view, done), retry);
    expect(retried.executions[joinPath]?.joinResolution).toBeNull();
    expect(retried.executions[joinPath]?.gateDecision).toBeNull();

    const gateRunning = runningNode(gatePath, "gate");
    const decided = ev(
      "gate.decided",
      { branch: "yes", evaluated: [{ branch: "yes", matched: true }] },
      { path: gatePath },
    );
    const gate = routed([...gateRunning, decided]);
    const nextGeneration = ev(
      "node.attempt.started",
      {
        attempt: 1,
        generation: 2,
        mode: "resume",
        resolvedConfigHash: "cfg",
        nodeKind: "gate",
        requireSubmission: false,
      },
      { path: gatePath },
    );
    expect(reduce(gate, nextGeneration).executions[gateKey]?.gateDecision).toBeNull();
  });
});
