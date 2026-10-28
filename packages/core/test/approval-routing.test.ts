import { describe, expect, it } from "vitest";
import {
  deriveRouting,
  emptyRunView,
  type Path,
  project,
  type RoutingGraph,
} from "../src/index.js";
import { ev, RUN_ID } from "./helpers.js";

describe("approval routing", () => {
  const base: RoutingGraph = {
    nodes: [
      { id: "a", type: "approval" },
      { id: "b", type: "agent" },
      { id: "c", type: "agent" },
    ],
    edges: [
      { id: "a-b", from: "a", to: "b" },
      { id: "a-c", from: "a.rejected", to: "c" },
    ],
  };
  it("succeeded approval without decision is dead (fail-closed)", () => {
    const r = deriveRouting(base, { a: { status: "succeeded", approvalDecision: null } });
    expect(r.edges["a-b"]).toBe("dead");
    expect(r.edges["a-c"]).toBe("dead");
    expect(r.ready).toEqual([]);
  });
  it("approve activates normal", () => {
    const r = deriveRouting(base, {
      a: { status: "succeeded", approvalDecision: { decision: "approve" } },
    });
    expect(r.edges["a-b"]).toBe("active");
    expect(r.edges["a-c"]).toBe("dead");
  });
  it("routes a legacy decision with null requestId by decision alone", () => {
    // ExecView carries requestId: null for legacy approvals; routing must
    // accept it without mapping and ignore it (only `decision` matters).
    const approved = deriveRouting(base, {
      a: { status: "succeeded", approvalDecision: { decision: "approve", requestId: null } },
    });
    expect(approved.edges["a-b"]).toBe("active");
    expect(approved.edges["a-c"]).toBe("dead");
    const rejected = deriveRouting(base, {
      a: { status: "succeeded", approvalDecision: { decision: "reject", requestId: null } },
    });
    expect(rejected.edges["a-b"]).toBe("dead");
    expect(rejected.edges["a-c"]).toBe("active");
  });
  it("reject activates .rejected", () => {
    const r = deriveRouting(base, {
      a: { status: "succeeded", approvalDecision: { decision: "reject" } },
    });
    expect(r.edges["a-b"]).toBe("dead");
    expect(r.edges["a-c"]).toBe("active");
  });
  it("terminal rejected is dead for all", () => {
    const r = deriveRouting(base, {
      a: { status: "rejected", approvalDecision: { decision: "reject" } },
    });
    expect(r.edges["a-b"]).toBe("dead");
    expect(r.edges["a-c"]).toBe("dead");
  });
  it("waiting_approval keeps pending", () => {
    const r = deriveRouting(base, { a: { status: "waiting_approval" } });
    expect(r.edges["a-b"]).toBe("pending");
  });
  it("replay legacy approval.requested without requestId stays non-resolvable", () => {
    let view = emptyRunView();
    view = project([
      ev(
        "run.created",
        { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
        { id: 1, runId: RUN_ID, path: "" as Path },
      ),
      ev("run.started", {}, { id: 2, runId: RUN_ID, path: "" as Path }),
      ev(
        "node.state",
        {
          from: "pending",
          to: "ready",
          attempt: 1,
          generation: 1,
          init: { kind: "approval", requireSubmission: false },
        },
        { id: 3, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.attempt.started",
        { attempt: 1, generation: 2, mode: "fresh", resolvedConfigHash: "" },
        { id: 4, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "ready", to: "running", attempt: 1, generation: 2 },
        { id: 5, runId: RUN_ID, path: "a" as Path },
      ),
      // legacy without requestId
      ev(
        "approval.requested",
        { message: "legacy", irreversible: false, autoApprove: false },
        { id: 6, runId: RUN_ID, path: "a" as Path },
      ),
    ]);
    const exec = view.executions["a"];
    expect(exec?.approvalRequest?.requestId).toBeNull();
    expect(exec?.approvalRequest?.attempt).toBeNull();
    expect(exec?.approvalRequest?.generation).toBeNull();
    // legacy without requestId must not become resolvable via fabricated identity
    expect(() =>
      project([
        ev(
          "run.created",
          {
            workflowId: "w",
            workflowHash: "h",
            runNumber: 1,
            params: {},
            budgets: {},
            kind: "run",
          },
          { id: 1, runId: RUN_ID, path: "" as Path },
        ),
        ev("run.started", {}, { id: 2, runId: RUN_ID, path: "" as Path }),
        ev(
          "node.state",
          {
            from: "pending",
            to: "ready",
            attempt: 1,
            generation: 1,
            init: { kind: "approval", requireSubmission: false },
          },
          { id: 3, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "node.attempt.started",
          { attempt: 1, generation: 2, mode: "fresh", resolvedConfigHash: "" },
          { id: 4, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "node.state",
          { from: "ready", to: "running", attempt: 1, generation: 2 },
          { id: 5, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "approval.requested",
          { message: "legacy", irreversible: false, autoApprove: false },
          { id: 6, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "approval.resolved",
          { decision: "approve", by: "u", requestId: "fake" },
          { id: 7, runId: RUN_ID, path: "a" as Path },
        ),
      ]),
    ).toThrow();
    // Ensure deriveRouting does not activate on legacy succeeded without decision
    const r = deriveRouting(base, { a: { status: "succeeded", approvalDecision: null } });
    expect(r.edges["a-b"]).toBe("dead");
  });
  it("legacy requested+resolved with omitted requestId rebuilds as audit", () => {
    const view = project([
      ev(
        "run.created",
        { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
        { id: 1, runId: RUN_ID, path: "" as Path },
      ),
      ev("run.started", {}, { id: 2, runId: RUN_ID, path: "" as Path }),
      ev(
        "node.state",
        {
          from: "pending",
          to: "ready",
          attempt: 1,
          generation: 1,
          init: { kind: "approval", requireSubmission: false },
        },
        { id: 3, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.attempt.started",
        { attempt: 1, generation: 2, mode: "fresh", resolvedConfigHash: "" },
        { id: 4, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "ready", to: "running", attempt: 1, generation: 2 },
        { id: 5, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.requested",
        { message: "legacy", irreversible: false, autoApprove: false },
        { id: 6, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "running", to: "waiting_approval", attempt: 1, generation: 2 },
        { id: 7, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.resolved",
        { decision: "approve", by: "u" },
        { id: 8, runId: RUN_ID, path: "a" as Path },
      ),
    ]);
    // audit only, no decision stored
    expect(view.executions["a"]?.approvalRequest?.requestId).toBeNull();
    expect(view.executions["a"]?.approvalDecision).toBeNull();
    expect(view.lastEventId).toBe(8);
  });
  it("resolved returns run to running", () => {
    const view = project([
      ev(
        "run.created",
        { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
        { id: 1, runId: RUN_ID, path: "" as Path },
      ),
      ev("run.started", {}, { id: 2, runId: RUN_ID, path: "" as Path }),
      ev(
        "node.state",
        {
          from: "pending",
          to: "ready",
          attempt: 1,
          generation: 1,
          init: { kind: "approval", requireSubmission: false },
        },
        { id: 3, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.attempt.started",
        { attempt: 1, generation: 2, mode: "fresh", resolvedConfigHash: "" },
        { id: 4, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "ready", to: "running", attempt: 1, generation: 2 },
        { id: 5, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.requested",
        {
          message: "m",
          irreversible: false,
          autoApprove: false,
          requestId: "req1",
          attempt: 1,
          generation: 2,
        },
        { id: 6, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "running", to: "waiting_approval", attempt: 1, generation: 2 },
        { id: 7, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.resolved",
        { decision: "approve", by: "u", requestId: "req1", attempt: 1, generation: 2 },
        { id: 8, runId: RUN_ID, path: "a" as Path },
      ),
    ]);
    expect(view.status).toBe("running");
    expect(view.executions["a"]?.approvalDecision?.requestId).toBe("req1");
  });
  it("retried approval clears old request/decision, stale old cannot resolve new", () => {
    const base = [
      ev(
        "run.created",
        { workflowId: "w", workflowHash: "h", runNumber: 1, params: {}, budgets: {}, kind: "run" },
        { id: 1, runId: RUN_ID, path: "" as Path },
      ),
      ev("run.started", {}, { id: 2, runId: RUN_ID, path: "" as Path }),
      ev(
        "node.state",
        {
          from: "pending",
          to: "ready",
          attempt: 1,
          generation: 1,
          init: { kind: "approval", requireSubmission: false },
        },
        { id: 3, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.attempt.started",
        { attempt: 1, generation: 2, mode: "fresh", resolvedConfigHash: "" },
        { id: 4, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "ready", to: "running", attempt: 1, generation: 2 },
        { id: 5, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.requested",
        {
          message: "m1",
          irreversible: false,
          autoApprove: false,
          requestId: "req1",
          attempt: 1,
          generation: 2,
        },
        { id: 6, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "running", to: "waiting_approval", attempt: 1, generation: 2 },
        { id: 7, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.resolved",
        { decision: "approve", by: "u", requestId: "req1", attempt: 1, generation: 2 },
        { id: 8, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "waiting_approval", to: "succeeded", attempt: 1, generation: 2 },
        { id: 9, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "succeeded", to: "pending", attempt: 2, generation: 1 },
        { id: 10, runId: RUN_ID, path: "a" as Path },
      ),
    ];
    const mid = project(base);
    expect(mid.executions["a"]?.approvalRequest).toBeNull();
    expect(mid.executions["a"]?.approvalDecision).toBeNull();
    expect(mid.executions["a"]?.attempt).toBe(2);
    const withNewReq = project([
      ...base,
      ev(
        "node.attempt.started",
        { attempt: 2, generation: 2, mode: "fresh", resolvedConfigHash: "" },
        { id: 11, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "pending", to: "ready", attempt: 2, generation: 2 },
        { id: 12, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "ready", to: "running", attempt: 2, generation: 2 },
        { id: 13, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.requested",
        {
          message: "m2",
          irreversible: false,
          autoApprove: false,
          requestId: "req2",
          attempt: 2,
          generation: 2,
        },
        { id: 14, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "running", to: "waiting_approval", attempt: 2, generation: 2 },
        { id: 15, runId: RUN_ID, path: "a" as Path },
      ),
    ]);
    expect(withNewReq.executions["a"]?.approvalRequest?.requestId).toBe("req2");
    expect(() =>
      project([
        ...base,
        ev(
          "node.attempt.started",
          { attempt: 2, generation: 2, mode: "fresh", resolvedConfigHash: "" },
          { id: 11, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "node.state",
          { from: "pending", to: "ready", attempt: 2, generation: 2 },
          { id: 12, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "node.state",
          { from: "ready", to: "running", attempt: 2, generation: 2 },
          { id: 13, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "approval.requested",
          {
            message: "m2",
            irreversible: false,
            autoApprove: false,
            requestId: "req2",
            attempt: 2,
            generation: 2,
          },
          { id: 14, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "node.state",
          { from: "running", to: "waiting_approval", attempt: 2, generation: 2 },
          { id: 15, runId: RUN_ID, path: "a" as Path },
        ),
        ev(
          "approval.resolved",
          { decision: "approve", by: "u", requestId: "req1", attempt: 2, generation: 2 },
          { id: 16, runId: RUN_ID, path: "a" as Path },
        ),
      ]),
    ).toThrow();
    const final = project([
      ...base,
      ev(
        "node.attempt.started",
        { attempt: 2, generation: 2, mode: "fresh", resolvedConfigHash: "" },
        { id: 11, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "pending", to: "ready", attempt: 2, generation: 2 },
        { id: 12, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "ready", to: "running", attempt: 2, generation: 2 },
        { id: 13, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.requested",
        {
          message: "m2",
          irreversible: false,
          autoApprove: false,
          requestId: "req2",
          attempt: 2,
          generation: 2,
        },
        { id: 14, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "node.state",
        { from: "running", to: "waiting_approval", attempt: 2, generation: 2 },
        { id: 15, runId: RUN_ID, path: "a" as Path },
      ),
      ev(
        "approval.resolved",
        { decision: "reject", by: "u", requestId: "req2", attempt: 2, generation: 2 },
        { id: 16, runId: RUN_ID, path: "a" as Path },
      ),
    ]);
    expect(final.executions["a"]?.approvalRequest?.requestId).toBe("req2");
    expect(final.executions["a"]?.approvalDecision?.requestId).toBe("req2");
  });
});
