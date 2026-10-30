import { emptyRunView, type RunStatus } from "@devchestra/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { RunRoute } from "../src/pages/RunPage.js";
import { createRunSession } from "../src/state/runSession.js";

vi.mock("../src/api/hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/hooks.js")>();
  return {
    ...actual,
    useBootstrap: () => ({ data: { projects: [] } }),
  };
});

const { mockSession } = vi.hoisted(() => ({ mockSession: vi.fn() }));

vi.mock("../src/api/useRunSession.js", () => ({
  useRunSession: (...args: unknown[]) => mockSession(...args),
}));

function sessionWith(headStatus: RunStatus, viewStatus: RunStatus, replayAt: number | null) {
  const base = createRunSession("r1");
  return {
    ...base,
    phase: "ready" as const,
    head: { ...emptyRunView(), status: headStatus, lastEventId: 10, runNumber: 3 },
    view: { ...emptyRunView(), status: viewStatus, lastEventId: 10, runNumber: 3 },
    events: [],
    historyLoaded: true,
    historyError: null,
    replayAt,
    replayMissing: false,
    offlineSince: null,
  };
}

function renderRunPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/p1/runs/r1"]}>
        <Routes>
          <Route path="/p/:pid/runs/:rid" element={<RunRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  mockSession.mockReset();
});

describe("RunPage stop control wiring", () => {
  it("can request cancellation even when the initial run snapshot cannot load", async () => {
    const cancel = vi
      .spyOn(api, "cancelRun")
      .mockResolvedValue({ runId: "r1" as never, status: "running" });
    mockSession.mockReturnValue({
      session: {
        ...createRunSession("r1"),
        phase: "error",
        errorCode: "E_INTERNAL",
        error: "Response contract violation for RunDetailResponse",
      },
      detail: null,
      retry: vi.fn(),
      setReplay: vi.fn(),
    });
    renderRunPage();
    expect(
      screen.getByText("Response contract violation for RunDetailResponse"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Request stop");
    fireEvent.click(screen.getByTestId("run-stop"));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("r1"));
    expect(await screen.findByTestId("run-stop-requested")).toHaveTextContent(
      "Stop requested. Run status is unavailable.",
    );
  });

  it("keeps stopping available when live event parsing fails", () => {
    mockSession.mockReturnValue({
      session: {
        ...sessionWith("running", "running", null),
        phase: "error",
        errorCode: "E_PROTOCOL",
        error: "Invalid 'run' SSE message",
      },
      detail: null,
      retry: vi.fn(),
      setReplay: vi.fn(),
    });
    renderRunPage();
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stop run");
  });

  it.each(["E_AUTH", "E_NOT_FOUND"])("does not offer stop for %s", (code) => {
    mockSession.mockReturnValue({
      session: { ...createRunSession("r1"), phase: "error", errorCode: code, error: "Unavailable" },
      detail: null,
      retry: vi.fn(),
      setReplay: vi.fn(),
    });
    renderRunPage();
    expect(screen.queryByTestId("run-stop")).toBeNull();
  });

  it("stops the live run while replaying: labels the live stop from the head, not the replay view", () => {
    mockSession.mockReturnValue({
      session: sessionWith("running", "succeeded", 5),
      detail: null,
      retry: vi.fn(),
      setReplay: vi.fn(),
    });
    renderRunPage();
    // The replay view says succeeded, but the live head is running: the stop
    // must stay, clearly labelled as a live-run stop.
    const button = screen.getByTestId("run-stop");
    expect(button).toHaveTextContent("Stop live run");
    expect(screen.getByTestId("run-page")).toBeInTheDocument();
  });

  it("hides the stop when the live head is terminal even if the shown view is active", () => {
    mockSession.mockReturnValue({
      session: sessionWith("cancelled", "running", null),
      detail: null,
      retry: vi.fn(),
      setReplay: vi.fn(),
    });
    renderRunPage();
    expect(screen.queryByTestId("run-stop")).toBeNull();
    expect(screen.getByTestId("run-page")).toBeInTheDocument();
  });

  it("keeps the stop next to the readonly snapshot chip without suppressing either", () => {
    mockSession.mockReturnValue({
      session: sessionWith("paused", "paused", null),
      detail: null,
      retry: vi.fn(),
      setReplay: vi.fn(),
    });
    renderRunPage();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stop run");
  });
});
