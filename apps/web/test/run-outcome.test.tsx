import type { RunStatus, RunView } from "@devchestra/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunOutcome } from "../src/run/RunOutcome.js";

function viewWith(
  status: RunStatus,
  overrides: Partial<Record<keyof RunView, unknown>> = {},
): RunView {
  return {
    status,
    runNumber: 1,
    executions: {},
    edges: {},
    providers: {},
    budget: { usd: 0, tokens: 0, activeMs: 0, supervisorUsd: 0 },
    activeSince: null,
    pausedAt: null,
    pausedMs: 0,
    pauseReason: null,
    pauseDetail: null,
    pausePath: null,
    supervisor: { wakes: 0, interventions: 0, recs: [] },
    errors: [],
    lastEventId: 3,
    ...overrides,
  } as unknown as RunView;
}

function exec(path: string, status: string) {
  return { path, nodeId: path, status, attempt: 1, generation: 1, kind: "agent" };
}

const nodeName = (nodeId: string) => (nodeId === "render" ? "Render summary" : nodeId);

describe("RunOutcome", () => {
  it("shows one status pill and no reason when the run succeeded", () => {
    render(<RunOutcome view={viewWith("succeeded")} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Succeeded");
    expect(screen.getByTestId("run-outcome")).not.toHaveTextContent("completed");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the failed step and its error after the status, and links to the step", () => {
    const onSelectPath = vi.fn();
    const view = viewWith("failed", {
      executions: { render: exec("render", "failed") },
      errors: [
        {
          eventId: 9,
          ts: "2026-10-31T09:34:01.000Z",
          path: "render",
          code: "E_EXIT",
          message: "exit status 1",
          details: null,
        },
      ],
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={onSelectPath} />);

    expect(screen.getByTestId("run-status")).toHaveTextContent("Failed");
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("at Render summary: exit status 1");
    fireEvent.click(screen.getByRole("button", { name: "View error" }));
    expect(onSelectPath).toHaveBeenCalledWith("render");
  });

  it("still gives the error when no step is recorded as failed", () => {
    const view = viewWith("failed", {
      errors: [
        { eventId: 2, ts: "", path: "", code: "E_RUN", message: "engine stopped", details: null },
      ],
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("engine stopped");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows what a live run is on", () => {
    const view = viewWith("running", { executions: { render: exec("render", "running") } });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Running");
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("Render summary");
  });

  it("links an approval wait to its step", () => {
    const onSelectPath = vi.fn();
    const view = viewWith("waiting_approval", {
      executions: { render: exec("render", "waiting_approval") },
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={onSelectPath} />);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Waiting for approval");
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("at Render summary");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onSelectPath).toHaveBeenCalledWith("render");
  });

  it("does not name a step for an error whose path matches no failed step", () => {
    const onSelectPath = vi.fn();
    const view = viewWith("failed", {
      executions: { render: exec("render", "failed") },
      errors: [
        { eventId: 4, ts: "", path: "other", code: "E_X", message: "unrelated", details: null },
      ],
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={onSelectPath} />);
    const outcome = screen.getByTestId("run-outcome");
    expect(outcome).toHaveTextContent("unrelated");
    expect(outcome).not.toHaveTextContent("Render summary");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the running step that started most recently, not an arbitrary one", () => {
    const view = viewWith("running", {
      executions: {
        build: { ...exec("build", "running"), startedAt: 100 },
        render: { ...exec("render", "running"), startedAt: 300 },
        lint: { ...exec("lint", "validating"), startedAt: 200 },
      },
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("Render summary");
    expect(screen.getByTestId("run-outcome")).not.toHaveTextContent("build");
  });

  it("breaks a start-time tie by path, so the choice is stable", () => {
    const view = viewWith("running", {
      executions: {
        zeta: { ...exec("zeta", "running"), startedAt: 50 },
        alpha: { ...exec("alpha", "running"), startedAt: 50 },
      },
    });
    render(<RunOutcome view={view} nodeName={(id) => `step ${id}`} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("step alpha");
  });

  it("says when a queued run is waiting on provider quota", () => {
    const view = viewWith("queued", {
      executions: { render: exec("render", "waiting_quota") },
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-outcome")).toHaveTextContent(
      "waiting for provider quota at Render summary",
    );
  });

  it("gives no step while a queued run has only unstarted work", () => {
    const view = viewWith("queued", {
      executions: { render: exec("render", "ready"), build: exec("build", "pending") },
    });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    const outcome = screen.getByTestId("run-outcome");
    expect(outcome).not.toHaveTextContent("Render summary");
    expect(outcome).not.toHaveTextContent("build");
  });

  it("uses the engine's pause detail as the reason when paused", () => {
    const view = viewWith("paused", { pauseDetail: "Quota reached for this provider." });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Paused");
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("Quota reached for this provider.");
  });
});
