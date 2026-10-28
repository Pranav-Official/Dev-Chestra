import {
  type EventEnvelope,
  type EventPayloads,
  emptyRunView,
  project,
  type RunId,
  type RunStatus,
  type RunView,
} from "@devchestra/core";
import { describe, expect, it } from "vitest";
import {
  applyLiveEvent,
  bootstrapSession,
  buildCheckpoints,
  CHECKPOINT_INTERVAL,
  createRunSession,
  findViewAt,
  markOffline,
  markOnline,
  markOverflow,
  resolveReplay,
  setReplayAt,
  showReconnectBanner,
} from "../src/state/runSession.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;
const OTHER_RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as RunId;

function event<K extends keyof EventPayloads>(
  id: number,
  type: K,
  payload: EventPayloads[K],
  runId: RunId = RUN_ID,
): EventEnvelope {
  return {
    id,
    runId,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    path: "" as EventEnvelope["path"],
    type,
    actor: "engine",
    v: 1,
    payload,
  } as unknown as EventEnvelope;
}

function unknownEvent(id: number): EventEnvelope {
  return {
    id,
    runId: RUN_ID,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    path: "" as EventEnvelope["path"],
    type: "future.event",
    actor: "system",
    v: 1,
    payload: { id },
  } as unknown as EventEnvelope;
}

const createdAt: EventPayloads["run.created"] = {
  workflowId: "wf",
  workflowHash: "hash",
  runNumber: 7,
  params: {},
  budgets: {},
  kind: "run",
};

function lifecycle(): EventEnvelope[] {
  return [
    event(10, "run.created", createdAt),
    event(12, "run.started", {}),
    event(20, "run.paused", { reason: "quota" }),
    event(25, "run.resumed", { reason: "timer" }),
    event(30, "run.cancelled", { by: "user" }),
  ];
}

function viewAt(events: EventEnvelope[], id: number): RunView {
  return project(events.filter((item) => item.id <= id));
}

describe("run session state", () => {
  it("bootstraps atomically from snapshot + watermark and applies only newer events", () => {
    const all = lifecycle();
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: viewAt(all, 12),
      watermark: 12,
      events: all,
      historyLoaded: true,
    });

    expect(session.phase).toBe("ready");
    expect(session.view?.status).toBe("cancelled");
    expect(session.safeCursor).toBe(30);
    expect(session.watermark).toBe(12);
    expect(session.historyLoaded).toBe(true);
  });

  it("dedupes by global event id and accepts ids with gaps", () => {
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: emptyRunView(),
      watermark: 0,
      events: [unknownEvent(10), unknownEvent(12)],
      historyLoaded: true,
    });
    session = applyLiveEvent(session, unknownEvent(12));
    session = applyLiveEvent(session, unknownEvent(10));
    expect(session.safeCursor).toBe(12);
    session = applyLiveEvent(session, unknownEvent(40));
    expect(session.safeCursor).toBe(40);
    expect(session.events.map((item) => item.id)).toEqual([10, 12, 40]);
    expect(session.events).toHaveLength(3);
  });

  it("ignores an event from another run and late older events", () => {
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: emptyRunView(),
      watermark: 0,
      events: [unknownEvent(50)],
      historyLoaded: true,
    });
    session = applyLiveEvent(session, unknownEvent(51));
    const before = session;
    session = applyLiveEvent(session, {
      ...unknownEvent(60),
      id: 60,
      runId: OTHER_RUN,
    } as EventEnvelope);
    expect(session).toBe(before);
    session = applyLiveEvent(session, unknownEvent(49));
    expect(session).toBe(before);
    expect(session.safeCursor).toBe(51);
  });

  it("updates head while a replay cursor stays fixed", () => {
    const all = lifecycle();
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: viewAt(all, 12),
      watermark: 12,
      events: all,
      historyLoaded: true,
    });
    session = setReplayAt(session, 20);
    expect(session.view?.status).toBe("paused");

    session = applyLiveEvent(session, unknownEvent(35));
    expect(session.safeCursor).toBe(35);
    expect(session.head.lastEventId).toBe(35);
    expect(session.view?.status).toBe("paused");
    expect(session.view?.lastEventId).toBe(20);

    session = setReplayAt(session, null);
    expect(session.view).toBe(session.head);
  });

  it("shows a pending replay until history arrives, then rejects an unknown event", () => {
    let session = createRunSession(RUN_ID);
    session = setReplayAt(session, 99);
    session = {
      ...session,
      phase: "ready",
      view: emptyRunView(),
      events: lifecycle(),
    };
    session = resolveReplay(session);
    expect(session.replayPending).toBe(true);
    expect(session.replayMissing).toBe(false);

    session = { ...session, historyLoaded: true };
    session = resolveReplay(session);
    expect(session.replayPending).toBe(false);
    expect(session.replayMissing).toBe(true);
    expect(session.view).toBeNull();
  });

  it("refetches snapshot/history after overflow and keeps a monotonically safe cursor", () => {
    const all = lifecycle();
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: viewAt(all, 20),
      watermark: 20,
      events: all.slice(0, 3),
      historyLoaded: true,
    });
    session = applyLiveEvent(session, unknownEvent(33));
    expect(session.safeCursor).toBe(33);
    session = markOverflow(session);
    expect(session.phase).toBe("overflow");

    const refreshed = [...all, unknownEvent(45), unknownEvent(70)];
    session = bootstrapSession(session, {
      view: viewAt(all, 25),
      watermark: 25,
      events: refreshed,
      historyLoaded: true,
    });
    expect(session.phase).toBe("ready");
    expect(session.overflow).toBe(false);
    expect(session.safeCursor).toBe(70);
    expect(session.safeCursor).toBeGreaterThanOrEqual(33);
  });

  it("answers replay N with exactly the same view as the core projection at N", () => {
    const all = lifecycle();
    const checkpoints = buildCheckpoints(all);
    for (const item of all) {
      expect(findViewAt(all, checkpoints, item.id)).toEqual(viewAt(all, item.id));
    }
  });

  it("keeps checkpoints at the configured interval and replays from them", () => {
    const events = Array.from({ length: 120 }, (_, index) => unknownEvent(index + 1));
    const checkpoints = buildCheckpoints(events);
    expect(checkpoints).toHaveLength(1 + Math.floor(events.length / CHECKPOINT_INTERVAL));
    const target = findViewAt(events, checkpoints, 119);
    expect(target?.lastEventId).toBe(119);
    expect(target).toEqual(project(events.slice(0, 119)));
  });

  it("only shows the reconnect banner after three seconds offline", () => {
    let session = createRunSession(RUN_ID);
    session = markOffline(session, 1_000);
    expect(showReconnectBanner(session, 3_999)).toBe(false);
    expect(showReconnectBanner(session, 4_000)).toBe(true);
    session = markOnline(session);
    expect(session.offlineSince).toBeNull();
    expect(showReconnectBanner(session, 9_000)).toBe(false);
  });

  it("does not report a replay match for a different run's global id", () => {
    const all = lifecycle();
    const session = {
      ...createRunSession(RUN_ID),
      events: all,
      checkpoints: buildCheckpoints(all),
      historyLoaded: true,
    };
    const replayed = setReplayAt(session, 11);
    expect(replayed.replayMissing).toBe(true);
    expect(replayed.view).toBeNull();
  });

  it("exposes a run status only through the reduced view", () => {
    const all = lifecycle();
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: viewAt(all, 20),
      watermark: 20,
      events: all.slice(0, 3),
      historyLoaded: true,
    });
    const status: RunStatus | undefined = session.view?.status;
    expect(status).toBe("paused");
  });

  it("applies live approval transition before history without checkpoint throw", () => {
    const prefix = Array.from({ length: 54 }, (_, i) => unknownEvent(i + 1));
    const initEvents: EventEnvelope[] = [
      ...prefix,
      event(55, "run.created", createdAt),
      event(56, "run.started", {}),
      event(57, "node.state", {
        from: "pending",
        to: "ready",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["node.state"]),
      event(58, "node.state", {
        from: "ready",
        to: "running",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["node.state"]),
      event(59, "node.state", {
        from: "running",
        to: "waiting_approval",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["node.state"]),
      event(60, "approval.requested", {
        message: "m",
        irreversible: false,
        autoApprove: false,
        requestId: "req1",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["approval.requested"]),
    ];
    for (const e of initEvents)
      if (e.type.startsWith("node.") || e.type.startsWith("approval."))
        (e as unknown as { path: string }).path = "approval";
    const waitingView = project(initEvents);
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: waitingView,
      watermark: waitingView.lastEventId,
      events: [],
      historyLoaded: false,
    });
    expect(session.historyLoaded).toBe(false);
    expect(session.checkpoints).toHaveLength(1); // only empty
    const live = event(61, "node.state", {
      from: "waiting_approval",
      to: "succeeded",
      attempt: 1,
      generation: 1,
    } as unknown as EventPayloads["node.state"]);
    (live as unknown as { path: string }).path = "approval";
    expect(() => {
      session = applyLiveEvent(session, live);
    }).not.toThrow();
    expect(session.head.executions["approval"]?.status).toBe("succeeded");
    expect(session.events).toHaveLength(1);
    expect(session.checkpoints).toHaveLength(1); // still deferred
    const completeHistory = initEvents.filter((e) => e.id <= waitingView.lastEventId);
    expect(() => {
      session = bootstrapSession(session, {
        view: waitingView,
        watermark: waitingView.lastEventId,
        events: completeHistory,
        historyLoaded: true,
      });
    }).not.toThrow();
    expect(session.historyLoaded).toBe(true);
    // Complete history has >50 events, so checkpoints must be created at interval 50
    expect(session.checkpoints.length).toBeGreaterThan(1);
    expect(session.events.length).toBe(completeHistory.length + 1);
  });

  it("keeps replay pending until history is complete, then resolves suffix event", () => {
    const prefix = Array.from({ length: 54 }, (_, i) => unknownEvent(i + 1));
    const initEvents: EventEnvelope[] = [
      ...prefix,
      event(55, "run.created", createdAt),
      event(56, "run.started", {}),
      event(57, "node.state", {
        from: "pending",
        to: "ready",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["node.state"]),
      event(58, "node.state", {
        from: "ready",
        to: "running",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["node.state"]),
      event(59, "node.state", {
        from: "running",
        to: "waiting_approval",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["node.state"]),
      event(60, "approval.requested", {
        message: "m",
        irreversible: false,
        autoApprove: false,
        requestId: "req1",
        attempt: 1,
        generation: 1,
      } as unknown as EventPayloads["approval.requested"]),
    ];
    for (const e of initEvents)
      if (e.type.startsWith("node.") || e.type.startsWith("approval."))
        (e as unknown as { path: string }).path = "approval";
    const waitingView = project(initEvents);
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: waitingView,
      watermark: waitingView.lastEventId,
      events: [],
      historyLoaded: false,
    });
    const live = event(61, "node.state", {
      from: "waiting_approval",
      to: "succeeded",
      attempt: 1,
      generation: 1,
    } as unknown as EventPayloads["node.state"]);
    (live as unknown as { path: string }).path = "approval";
    session = applyLiveEvent(session, live);
    // Request replay for the suffix event before history is loaded — must stay pending, not throw
    session = setReplayAt(session, 61);
    expect(session.replayPending).toBe(true);
    expect(session.view).toBeNull();
    // Now history arrives (complete prefix)
    const completeHistory = [...initEvents, live];
    session = bootstrapSession(session, {
      view: waitingView,
      watermark: waitingView.lastEventId,
      events: completeHistory,
      historyLoaded: true,
    });
    expect(session.historyLoaded).toBe(true);
    // Replay should now resolve to the live event's view
    session = setReplayAt(session, 61);
    expect(session.replayMissing).toBe(false);
    expect(session.view?.lastEventId).toBe(61);
    expect(session.view?.executions["approval"]?.status).toBe("succeeded");
  });

  it("re-applies the same replay cursor without rebuilding the session", () => {
    const all = lifecycle();
    let session = createRunSession(RUN_ID);
    session = bootstrapSession(session, {
      view: viewAt(all, 12),
      watermark: 12,
      events: all,
      historyLoaded: true,
    });
    session = setReplayAt(session, 20);
    const settled = session;
    // Same cursor again (e.g. the ?at= effect firing after an eager scrub
    // update) must be a no-op so the run canvas does not re-render.
    expect(setReplayAt(session, 20)).toBe(settled);
    expect(setReplayAt(session, null)).not.toBe(settled);
    session = setReplayAt(session, null);
    expect(session.view).toBe(session.head);
    expect(setReplayAt(session, null)).toBe(session);
  });
});
