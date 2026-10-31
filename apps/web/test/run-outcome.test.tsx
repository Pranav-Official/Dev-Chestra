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

  it("uses the engine's pause detail as the reason when paused", () => {
    const view = viewWith("paused", { pauseDetail: "Quota reached for this provider." });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Paused");
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("Quota reached for this provider.");
  });
});
