import type { RunStatus, RunView } from "@devchestra/core";
import { render, screen } from "@testing-library/react";
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
    lastEventId: 1,
    ...overrides,
  } as unknown as RunView;
}

function exec(path: string, status: string) {
  return { path, nodeId: path, status, attempt: 1, generation: 1, kind: "agent" };
}

const nodeName = (nodeId: string) => (nodeId === "render" ? "Render summary" : nodeId);

describe("queued run outcome", () => {
  it("says a queued run is waiting for an execution slot", () => {
    render(<RunOutcome view={viewWith("queued")} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Queued");
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("Waiting for an execution slot");
  });

  it("keeps the quota reason when a queued run's step is waiting on provider quota", () => {
    const view = viewWith("queued", { executions: { render: exec("render", "waiting_quota") } });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-outcome")).toHaveTextContent(
      "waiting for provider quota at Render summary",
    );
    expect(screen.getByTestId("run-outcome")).not.toHaveTextContent(
      "Waiting for an execution slot",
    );
  });

  it("does not show the slot wait once the run is running", () => {
    const view = viewWith("running", { executions: { render: exec("render", "running") } });
    render(<RunOutcome view={view} nodeName={nodeName} onSelectPath={vi.fn()} />);
    expect(screen.getByTestId("run-outcome")).toHaveTextContent("Render summary");
    expect(screen.getByTestId("run-outcome")).not.toHaveTextContent(
      "Waiting for an execution slot",
    );
  });
});
