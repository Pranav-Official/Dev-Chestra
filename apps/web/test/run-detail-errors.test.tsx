import { emptyRunView, type Path, type RunView } from "@relay/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailPanel } from "../src/run/DetailPanel.js";

function withQuery(c: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {c}
    </QueryClientProvider>
  );
}

function viewWithErrors(errors: RunView["errors"]): RunView {
  return { ...emptyRunView(), errors, lastEventId: errors.length };
}

function panel(view: RunView) {
  return withQuery(
    <DetailPanel
      run={null}
      runId="run-1"
      path={null}
      nodeLabel={null}
      view={view}
      events={[]}
      isReplay={false}
      snapshot={null}
    />,
  );
}

describe("run error banner", () => {
  it("renders the saved stderr diagnostic under code and message", () => {
    render(
      panel(
        viewWithErrors([
          {
            eventId: 7,
            ts: new Date(0).toISOString(),
            path: "agent" as Path,
            code: "E_CLI_CRASH",
            message: "Agent node failed: crash",
            details: {
              reason: "crash",
              exitCode: 1,
              signal: null,
              stderr: "Pi error: credentials_not_configured",
            },
          },
        ]),
      ),
    );
    expect(screen.getByText("E_CLI_CRASH: Agent node failed: crash")).toBeDefined();
    expect(screen.getByTestId("run-error-stderr")).toHaveTextContent(
      "Pi error: credentials_not_configured",
    );
  });

  it("omits the diagnostic block when details carry no stderr", () => {
    render(
      panel(
        viewWithErrors([
          {
            eventId: 8,
            ts: new Date(0).toISOString(),
            path: "agent" as Path,
            code: "E_INTERNAL",
            message: "boom",
            details: { reason: "x" },
          },
        ]),
      ),
    );
    expect(screen.queryByTestId("run-error-stderr")).toBeNull();
  });
});
