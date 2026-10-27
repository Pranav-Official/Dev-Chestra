import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HomePage } from "../src/pages/HomePage.js";

function withRouter(c: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{c}</MemoryRouter>
    </QueryClientProvider>
  );
}
function mockFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    for (const [k, v] of Object.entries(map))
      if (u.includes(k))
        return {
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          text: async () => JSON.stringify(v),
          json: async () => v,
        } as unknown as Response;
    return {
      ok: true,
      headers: new Headers({ "X-Relay-Api": "1" }),
      status: 200,
      text: async () => JSON.stringify({}),
      json: async () => ({}),
    } as unknown as Response;
  });
}

describe("HomePage inbox canonical", () => {
  it("shows pending approval even when >8 newer runs exist", async () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5FA${String.fromCharCode(65 + i)}`,
      projectId: "p1",
      projectName: "P1",
      workflowId: "wf",
      workflowName: "Wf",
      runNumber: 10 - i,
      status: "succeeded",
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: Date.now(),
      pauseReason: null,
      costUsd: 0,
      tokens: 0,
      activeMs: 0,
    }));
    const approvals = {
      items: [
        {
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          path: "approval",
          nodeId: "approval",
          status: "waiting_approval",
          message: "need ok",
          criteria: null,
          irreversible: false,
          requestedAt: Date.now(),
          attempt: 1,
          generation: 1,
          requestId: "req1",
          expectedAttempt: 1,
          expectedGeneration: 1,
          requestEventId: 10,
          projectId: "p1",
          runNumber: 42,
        },
      ],
      nextCursor: null,
    };
    const fm = mockFetch({
      "/api/bootstrap": {
        version: "1",
        instanceId: "i",
        projects: [
          { id: "p1", name: "P1", path: "/tmp/p1", kind: "git", missing: false, addedAt: 0 },
        ],
        counts: { runs: 10, activeRuns: 1, inbox: 1 },
        providers: [],
        clis: [],
        settings: { server: { port: 4821 }, defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 } },
      },
      "/api/runs": { items: runs, nextCursor: null },
      "/api/approvals": approvals,
    });
    globalThis.fetch = fm as unknown as typeof fetch;
    render(withRouter(<HomePage />));
    await waitFor(() => expect(screen.getByTestId("inbox-list")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-list").textContent).toContain("need ok");
    const link = screen
      .getByTestId("inbox-01ARZ3NDEKTSV4RRFFQ69G5FAV")
      .querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("path=approval");
    expect(link.getAttribute("href")).toContain("/p/p1/r/01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("failed fetch shows error vs empty", async () => {
    const fmFail = vi.fn(async (url: string) => {
      if (String(url).includes("/api/approvals"))
        return {
          ok: false,
          status: 500,
          headers: new Headers({ "X-Relay-Api": "1" }),
          text: async () => JSON.stringify({ error: { code: "E_INTERNAL", message: "boom" } }),
          json: async () => ({ error: { code: "E_INTERNAL", message: "boom" } }),
        } as unknown as Response;
      if (String(url).includes("/api/bootstrap"))
        return {
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          text: async () =>
            JSON.stringify({
              version: "1",
              instanceId: "i",
              projects: [],
              counts: { runs: 0, activeRuns: 0, inbox: 0 },
              providers: [],
              clis: [],
              settings: {
                server: { port: 4821 },
                defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 },
              },
            }),
          json: async () => ({
            version: "1",
            instanceId: "i",
            projects: [],
            counts: { runs: 0, activeRuns: 0, inbox: 0 },
            providers: [],
            clis: [],
            settings: {
              server: { port: 4821 },
              defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 },
            },
          }),
        } as unknown as Response;
      if (String(url).includes("/api/runs"))
        return {
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          text: async () => JSON.stringify({ items: [], nextCursor: null }),
          json: async () => ({ items: [], nextCursor: null }),
        } as unknown as Response;
      return {
        ok: true,
        headers: new Headers({ "X-Relay-Api": "1" }),
        status: 200,
        text: async () => "{}",
        json: async () => ({}),
      } as unknown as Response;
    });
    globalThis.fetch = fmFail as unknown as typeof fetch;
    render(withRouter(<HomePage />));
    await waitFor(() => expect(screen.getByTestId("inbox-error")).toBeInTheDocument());
    // empty after success
    const fmEmpty = mockFetch({
      "/api/bootstrap": {
        version: "1",
        instanceId: "i",
        projects: [],
        counts: { runs: 0, activeRuns: 0, inbox: 0 },
        providers: [],
        clis: [],
        settings: { server: { port: 4821 }, defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 } },
      },
      "/api/runs": { items: [], nextCursor: null },
      "/api/approvals": { items: [], nextCursor: null },
    });
    globalThis.fetch = fmEmpty as unknown as typeof fetch;
    // rerender fresh
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("inbox-empty").length).toBeGreaterThan(0));
  });

  it("load more pagination not silently limited", async () => {
    const baseId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const page1 = {
      items: Array.from({ length: 50 }, (_, i) => ({
        runId: baseId,
        path: `a${i}`,
        nodeId: `a${i}`,
        status: "waiting_approval",
        message: `m${i}`,
        criteria: null,
        irreversible: false,
        requestedAt: Date.now(),
        attempt: 1,
        generation: 1,
        requestId: `r${i}`,
        expectedAttempt: 1,
        expectedGeneration: 1,
        requestEventId: i,
        projectId: "p1",
        runNumber: i + 1,
      })),
      nextCursor: "c1",
    };
    const page2 = {
      items: [
        {
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          path: "a50",
          nodeId: "a50",
          status: "waiting_approval",
          message: "m50",
          criteria: null,
          irreversible: false,
          requestedAt: Date.now(),
          attempt: 1,
          generation: 1,
          requestId: "r50",
          expectedAttempt: 1,
          expectedGeneration: 1,
          requestEventId: 50,
          projectId: "p1",
          runNumber: 51,
        },
      ],
      nextCursor: null,
    };
    let call = 0;
    const fm = vi.fn(async (url: string) => {
      if (String(url).includes("/api/approvals")) {
        call += 1;
        const data = call === 1 ? page1 : page2;
        return {
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          text: async () => JSON.stringify(data),
          json: async () => data,
        } as unknown as Response;
      }
      if (String(url).includes("/api/bootstrap"))
        return {
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          text: async () =>
            JSON.stringify({
              version: "1",
              instanceId: "i",
              projects: [],
              counts: { runs: 0, activeRuns: 0, inbox: 0 },
              providers: [],
              clis: [],
              settings: {
                server: { port: 4821 },
                defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 },
              },
            }),
          json: async () => ({
            version: "1",
            instanceId: "i",
            projects: [],
            counts: { runs: 0, activeRuns: 0, inbox: 0 },
            providers: [],
            clis: [],
            settings: {
              server: { port: 4821 },
              defaults: { agentTimeoutMin: 10, shellTimeoutMin: 5 },
            },
          }),
        } as unknown as Response;
      if (String(url).includes("/api/runs"))
        return {
          ok: true,
          headers: new Headers({ "X-Relay-Api": "1" }),
          status: 200,
          text: async () => JSON.stringify({ items: [], nextCursor: null }),
          json: async () => ({ items: [], nextCursor: null }),
        } as unknown as Response;
      return {
        ok: true,
        headers: new Headers({ "X-Relay-Api": "1" }),
        status: 200,
        text: async () => "{}",
        json: async () => ({}),
      } as unknown as Response;
    });
    globalThis.fetch = fm as unknown as typeof fetch;
    render(withRouter(<HomePage />));
    await waitFor(() => expect(screen.getByTestId("inbox-list")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-load-more")).toBeInTheDocument();
    // click load more
    screen.getByTestId("inbox-load-more").click();
    await waitFor(() => expect(screen.getByText("m50")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-01ARZ3NDEKTSV4RRFFQ69G5FAW")).toBeInTheDocument();
  });
});
