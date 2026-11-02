import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  armPoll,
  closeAllPollHarnesses,
  createPollHarness,
  type PollHarness,
  PROJECT_ID,
  pollWorkflow,
  WORKFLOW_ID,
} from "./polling-harness.js";

let h: PollHarness;

beforeEach(() => {
  h = createPollHarness();
  h.writeWorkflow(WORKFLOW_ID, pollWorkflow());
});

afterEach(() => {
  closeAllPollHarnesses();
});

async function tick(at: number): Promise<void> {
  await h.scheduler.tick(at);
}

function triggerOf() {
  return h.store.pollTriggers.trigger(PROJECT_ID, WORKFLOW_ID);
}

describe("scheduler ticks", () => {
  it("does nothing while no poller is due", async () => {
    await armPoll(h, 60);
    await tick(h.clock.now());
    expect(h.probes).toHaveLength(0);
    expect(h.launches).toHaveLength(0);
    expect(triggerOf()).toMatchObject({ lastTickAt: null, lastOutcome: null });
  });

  it("records nothing on a quiet probe and deletes the probe run", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: "", exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    expect(h.probes).toHaveLength(1);
    expect(h.launches).toHaveLength(0);
    expect(triggerOf()).toMatchObject({ lastOutcome: "nothing", consecutiveFailures: 0 });
    const [probeRun] = h.probeRunIds;
    expect(h.store.runs.get(probeRun as never)).toBeNull();
  });

  it("triggers a run on the armed snapshot with a new worktree and binds the dedupe key", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4, "dedupeKey": "k-1"}', exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workspace: { mode: "new-worktree" },
      params: { pr: 4, title: "none" },
    });
    expect(triggerOf()).toMatchObject({ lastOutcome: "triggered", consecutiveFailures: 0 });
    expect(typeof triggerOf()?.lastRunId).toBe("string");
    // The probe run of a triggering tick is kept, capped at 20 per workflow.
    expect(h.store.runs.get(h.probeRunIds[0] as never)?.kind).toBe("poll_probe");
  });

  it("skips a repeat key as a duplicate and launches nothing", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4, "dedupeKey": "k-1"}', exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 9, "dedupeKey": "k-1"}', exitCode: 0 });
    await tick(h.clock.now() + 20_000);
    expect(h.launches).toHaveLength(1);
    expect(triggerOf()).toMatchObject({ lastOutcome: "duplicate" });
  });

  it("re-triggers when the probe emits a new dedupe key", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4, "dedupeKey": "sha:1"}', exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4, "dedupeKey": "sha:2"}', exitCode: 0 });
    await tick(h.clock.now() + 20_000);
    expect(h.launches).toHaveLength(2);
    expect(triggerOf()).toMatchObject({ lastOutcome: "triggered" });
  });

  it("hashes the params when the probe returns no dedupe key", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4}', exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4}', exitCode: 0 });
    await tick(h.clock.now() + 20_000);
    expect(h.launches).toHaveLength(1);
    expect(triggerOf()).toMatchObject({ lastOutcome: "duplicate" });
  });

  it("launches every result when dedupe is off", async () => {
    h.writeWorkflow(
      WORKFLOW_ID,
      pollWorkflow({
        polling: { enabled: true, probe: { type: "shell", command: "x" }, dedupe: false },
      }),
    );
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4}', exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 4}', exitCode: 0 });
    await tick(h.clock.now() + 20_000);
    expect(h.launches).toHaveLength(2);
    expect(triggerOf()).toMatchObject({ lastOutcome: "triggered" });
  });

  it("accepts a bare line for a single-param start", async () => {
    h.writeWorkflow(
      WORKFLOW_ID,
      pollWorkflow({
        polling: { enabled: true, probe: { type: "shell", command: "x" } },
        params: [{ name: "url", type: "string", required: true }],
      }),
    );
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: "https://example.test/pr/7\n", exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.params).toEqual({ url: "https://example.test/pr/7" });
  });

  it("records failed ticks and auto-disarms after five in a row", async () => {
    await armPoll(h, 10);
    for (let i = 0; i < 4; i++) {
      h.probeScript.push({ fail: "E_POLL_PROBE" });
      await tick(h.clock.now() + (i + 1) * 10_000);
      expect(triggerOf()).toMatchObject({ armed: true, consecutiveFailures: i + 1 });
    }
    h.probeScript.push({ fail: "E_POLL_PROBE" });
    await tick(h.clock.now() + 50_000);
    expect(triggerOf()).toMatchObject({
      armed: false,
      consecutiveFailures: 5,
      lastOutcome: "failed",
    });
    expect(typeof triggerOf()?.lastError).toBe("string");
    // A disarmed poller is never due again.
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 1}', exitCode: 0 });
    await tick(h.clock.now() + 60_000);
    expect(h.probes).toHaveLength(5);
  });

  it("records failed ticks for invalid probe params", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: '{"title": "no pr"}', exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    expect(h.launches).toHaveLength(0);
    expect(triggerOf()).toMatchObject({ lastOutcome: "failed", consecutiveFailures: 1 });
  });

  it("skips a tick while the previous probe for that workflow is still running", async () => {
    await armPoll(h, 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gateProbe = () => gate;
    const first = h.scheduler.tick(h.clock.now() + 10_000);
    for (let i = 0; i < 100 && h.enteredProbes() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(h.enteredProbes()).toBe(1);
    await tick(h.clock.now() + 10_000);
    expect(h.enteredProbes()).toBe(1);
    expect(triggerOf()).toMatchObject({ lastOutcome: "skipped", consecutiveFailures: 0 });
    release();
    await first;
    expect(triggerOf()).toMatchObject({ lastOutcome: "nothing" });
  });

  it("does not record a tick that finishes after a disarm", async () => {
    await armPoll(h, 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gateProbe = () => gate;
    const first = h.scheduler.tick(h.clock.now() + 10_000);
    for (let i = 0; i < 100 && h.enteredProbes() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await api(h, "POST", `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/polling/disarm`);
    release();
    await first;
    // The disarm's own state stands; the late probe records nothing.
    expect(triggerOf()).toMatchObject({ armed: false, lastOutcome: null });
  });

  it("does not trigger from a superseded revision when a refresh lands mid-probe", async () => {
    await armPoll(h, 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gateProbe = () => gate;
    h.probeScript.push({ kind: "shell", stdout: '{"pr": 9, "dedupeKey": "k-9"}', exitCode: 0 });
    const first = h.scheduler.tick(h.clock.now() + 10_000);
    for (let i = 0; i < 100 && h.enteredProbes() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const before = triggerOf()?.armedRevision;
    h.writeWorkflow(WORKFLOW_ID, { ...pollWorkflow(), name: "Renamed mid-probe" });
    await api(h, "POST", `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/polling/refresh`);
    expect(triggerOf()?.armedRevision).not.toBe(before);
    release();
    await first;
    // The late probe found something, but it belongs to the old revision: no run, no tick.
    expect(h.launches).toHaveLength(0);
    expect(triggerOf()).toMatchObject({ armed: true, lastOutcome: null });
  });

  it("keeps the probe timeout below the interval", async () => {
    await armPoll(h, 10);
    h.probeScript.push({ kind: "shell", stdout: "", exitCode: 0 });
    await tick(h.clock.now() + 10_000);
    expect(h.probes[0]?.timeoutMs).toBeLessThan(10_000);
  });

  it("prunes triggering probe runs to the newest twenty", async () => {
    await armPoll(h, 10);
    for (let i = 0; i < 22; i++) {
      h.probeScript.push({ kind: "shell", stdout: `{"pr": ${i}}`, exitCode: 0 });
      await tick(h.clock.now() + (i + 1) * 10_000);
    }
    expect(h.launches).toHaveLength(22);
    const kept = h.store.runs
      .list({ includeProbeRuns: true })
      .items.filter((item) => item.kind === "poll_probe");
    expect(kept).toHaveLength(20);
  });
});

describe("scheduler boot", () => {
  it("skips the catch-up burst and resumes on schedule", async () => {
    await armPoll(h, 60);
    // Ten intervals of downtime: the poller is long overdue.
    h.clock.advance(600_000);
    h.scheduler.start();
    h.scheduler.stop();
    expect(h.probes).toHaveLength(0);
    expect(triggerOf()).toMatchObject({ lastOutcome: "skipped" });
    // Nothing is due until the fresh interval passes.
    await tick(h.clock.now());
    expect(h.probes).toHaveLength(0);
    h.clock.advance(60_000);
    h.probeScript.push({ kind: "shell", stdout: "", exitCode: 0 });
    await tick(h.clock.now());
    expect(h.probes).toHaveLength(1);
  });

  it("start and stop are safe to repeat", () => {
    h.scheduler.start();
    h.scheduler.start();
    h.scheduler.stop();
    h.scheduler.stop();
  });
});
