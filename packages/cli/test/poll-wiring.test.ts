import type { Engine } from "@devchestra/engine";
import { PollScheduler } from "@devchestra/server";
import type { Store } from "@devchestra/store";
import { describe, expect, it, vi } from "vitest";
import { createPollPorts, createPollScheduler } from "../src/poll-wiring.js";

function stubEngine(): Engine {
  return {
    launch: vi.fn(async () => ({
      ok: true as const,
      value: {
        runId: "run-1",
        duplicate: false,
        completion: Promise.resolve({ runId: "run-1", status: "succeeded" }),
      },
    })),
    probe: vi.fn(async () => ({
      ok: true as const,
      value: {
        runId: "probe-1",
        raw: { kind: "shell" as const, stdout: '{"pr": 1}', exitCode: 0 },
        durationMs: 4,
      },
    })),
    pumpQueue: vi.fn(),
  } as unknown as Engine;
}

const SNAPSHOT = {
  schemaVersion: 1,
  id: "wf",
  name: "wf",
  graph: { nodes: [], edges: [] },
} as never;

describe("createPollPorts", () => {
  it("launches triggered runs on the armed snapshot with a new worktree", async () => {
    const engine = stubEngine();
    const ports = createPollPorts({} as Store, engine);
    const launched = await ports.runs.launch({
      projectId: "p",
      workflowId: "wf",
      snapshot: SNAPSHOT,
      snapshotRaw: "{}",
      params: { pr: 1 },
      workspace: { mode: "new-worktree" },
      workflowDependencies: { child: SNAPSHOT },
    });
    expect(launched.runId).toBe("run-1");
    expect(engine.launch).toHaveBeenCalledWith({
      projectId: "p",
      workflowId: "wf",
      snapshot: SNAPSHOT,
      snapshotRaw: "{}",
      params: { pr: 1 },
      workspace: { mode: "new-worktree" },
      workflowDependencies: { child: SNAPSHOT },
    });
  });

  it("probes through the engine and rethrows its refusals", async () => {
    const engine = stubEngine();
    const ports = createPollPorts({} as Store, engine);
    const probe = {
      id: "probe" as const,
      type: "shell" as const,
      name: "Poll probe",
      command: "true",
    };
    const outcome = await ports.runs.probe({
      projectId: "p",
      workflowId: "wf",
      snapshot: SNAPSHOT,
      probe,
      workspace: "project",
      timeoutMs: 9_000,
    });
    expect(outcome.runId).toBe("probe-1");
    expect(engine.probe).toHaveBeenCalledWith({
      projectId: "p",
      workflowId: "wf",
      snapshot: SNAPSHOT,
      probe,
      workspace: "project",
      timeoutMs: 9_000,
    });

    const refusing = stubEngine();
    (refusing.probe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false as const,
      error: new Error("E_CLI_DISABLED"),
    });
    await expect(
      createPollPorts({} as Store, refusing).runs.probe({
        projectId: "p",
        workflowId: "wf",
        snapshot: SNAPSHOT,
        probe,
        workspace: "project",
        timeoutMs: 9_000,
      }),
    ).rejects.toThrow("E_CLI_DISABLED");
  });

  it("pumps the engine queue", () => {
    const engine = stubEngine();
    createPollPorts({} as Store, engine).runs.pumpQueue();
    expect(engine.pumpQueue).toHaveBeenCalledTimes(1);
  });
});

describe("createPollScheduler", () => {
  it("returns a stopped scheduler the server process can start and stop", () => {
    const scheduler = createPollScheduler(createPollPorts({} as Store, stubEngine()));
    expect(scheduler).toBeInstanceOf(PollScheduler);
    scheduler.start();
    scheduler.stop();
  });
});
