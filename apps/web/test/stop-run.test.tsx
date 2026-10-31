import type { RunId, RunStatus } from "@devchestra/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { StopRunButton } from "../src/run/StopRunButton.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

function renderStop(headStatus: RunStatus, isReplay = false) {
  return render(<StopRunButton runId={RUN_ID} headStatus={headStatus} isReplay={isReplay} />);
}

/** Stop is two steps: the control asks, the confirm step sends the request. */
function requestStop() {
  fireEvent.click(screen.getByTestId("run-stop"));
  fireEvent.click(screen.getByTestId("run-stop-confirm"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StopRunButton visibility", () => {
  it.each([["queued"], ["running"], ["paused"], ["waiting_approval"]] as RunStatus[][])(
    "renders an enabled stop for live nonterminal status %s",
    (status) => {
      vi.spyOn(api, "cancelRun").mockResolvedValue({ runId: RUN_ID, status });
      renderStop(status);
      const button = screen.getByTestId("run-stop");
      expect(button).toBeEnabled();
      expect(button).toHaveTextContent("Stop run");
      expect(button).toHaveAttribute("aria-label", "Stop this run");
    },
  );

  it.each([["succeeded"], ["failed"], ["rejected"], ["cancelled"]] as RunStatus[][])(
    "hides the stop for terminal status %s",
    (status) => {
      const cancel = vi.spyOn(api, "cancelRun");
      renderStop(status);
      expect(screen.queryByTestId("run-stop")).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
    },
  );
});

describe("StopRunButton confirmation", () => {
  it("asks first and never posts from the initial click", () => {
    const cancel = vi.spyOn(api, "cancelRun");
    renderStop("running");

    fireEvent.click(screen.getByTestId("run-stop"));
    expect(screen.getByTestId("run-stop-confirm")).toHaveTextContent("Confirm stop");
    expect(screen.getByRole("group", { name: "Confirm stopping this run" })).toHaveTextContent(
      "Stop this run?",
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it("backs out without sending when the user keeps the run going", () => {
    const cancel = vi.spyOn(api, "cancelRun");
    renderStop("running");

    fireEvent.click(screen.getByTestId("run-stop"));
    fireEvent.click(screen.getByTestId("run-stop-keep"));
    expect(screen.queryByTestId("run-stop-confirm")).toBeNull();
    expect(screen.getByTestId("run-stop")).toBeEnabled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("backs out on Escape without sending", () => {
    const cancel = vi.spyOn(api, "cancelRun");
    renderStop("running");

    fireEvent.click(screen.getByTestId("run-stop"));
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(screen.queryByTestId("run-stop-confirm")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("asks in replay with the live-run wording", () => {
    renderStop("running", true);
    fireEvent.click(screen.getByTestId("run-stop"));
    expect(screen.getByRole("group", { name: "Confirm stopping the live run" })).toHaveTextContent(
      "Stop the live run?",
    );
  });
});

describe("StopRunButton cancel flow", () => {
  it("shows Stopping… while the request is in flight and never claims Cancelled optimistically", async () => {
    const gate = deferred<{ runId: string; status: RunStatus }>();
    const cancel = vi.spyOn(api, "cancelRun").mockReturnValue(gate.promise as never);
    renderStop("running");

    requestStop();
    expect(screen.getByTestId("run-stop")).toBeDisabled();
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stopping…");

    gate.resolve({ runId: RUN_ID, status: "running" });
    // Accepted, not confirmed: the control stays in Stopping… until live
    // terminal evidence arrives — no Cancelled claim, no re-enabled button.
    await screen.findByTestId("run-stop-requested");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(RUN_ID);
    expect(screen.getByTestId("run-stop")).toBeDisabled();
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stopping…");
    expect(screen.queryByText(/cancelled/i)).toBeNull();
    expect(screen.getByTestId("run-stop-requested")).toHaveTextContent(
      "Confirming the run stopped…",
    );
  });

  it("ignores a second click after an accepted 202 while confirmation is pending", async () => {
    const cancel = vi
      .spyOn(api, "cancelRun")
      .mockResolvedValue({ runId: RUN_ID, status: "running" });
    renderStop("running");

    requestStop();
    await screen.findByTestId("run-stop-requested");
    expect(screen.getByTestId("run-stop")).toBeDisabled();

    // The synchronous requested fence drops this even though jsdom dispatches
    // click events on disabled buttons.
    fireEvent.click(screen.getByTestId("run-stop"));
    fireEvent.click(screen.getByTestId("run-stop"));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stopping…");
  });

  it("collapses duplicate clicks into a single request", async () => {
    const gate = deferred<{ runId: string; status: RunStatus }>();
    const cancel = vi.spyOn(api, "cancelRun").mockReturnValue(gate.promise as never);
    renderStop("paused");

    requestStop();
    fireEvent.click(screen.getByTestId("run-stop"));
    fireEvent.click(screen.getByTestId("run-stop"));
    expect(cancel).toHaveBeenCalledTimes(1);

    gate.resolve({ runId: RUN_ID, status: "paused" });
    await screen.findByTestId("run-stop-requested");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("run-stop")).toBeDisabled();
  });

  it("shows an error with retry that clears on retry, and dismiss without retrying", async () => {
    const cancel = vi
      .spyOn(api, "cancelRun")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ runId: RUN_ID, status: "running" });
    renderStop("waiting_approval");

    requestStop();
    expect(await screen.findByTestId("run-stop-error")).toHaveTextContent("network down");
    expect(screen.getByTestId("run-stop-retry")).toBeInTheDocument();

    // Retry clears the stale error immediately, then posts again and returns
    // to Stopping… until confirmation.
    fireEvent.click(screen.getByTestId("run-stop-retry"));
    await waitFor(() => expect(screen.queryByTestId("run-stop-error")).toBeNull());
    expect(cancel).toHaveBeenCalledTimes(2);
    await screen.findByTestId("run-stop-requested");
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stopping…");
  });

  it("dismisses the error without sending another request", async () => {
    const cancel = vi.spyOn(api, "cancelRun").mockRejectedValueOnce(new Error("boom"));
    renderStop("running");

    requestStop();
    expect(await screen.findByTestId("run-stop-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("run-stop-dismiss"));
    expect(screen.queryByTestId("run-stop-error")).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("suppresses the error when the live run turned terminal mid-flight (completion race)", async () => {
    const gate = deferred<{ runId: string; status: RunStatus }>();
    const cancel = vi.spyOn(api, "cancelRun").mockReturnValue(gate.promise as never);
    const view = renderStop("running");

    requestStop();
    // Backend-confirmed terminal evidence arrives before the POST settles.
    view.rerender(<StopRunButton runId={RUN_ID} headStatus="succeeded" isReplay={false} />);
    expect(screen.queryByTestId("run-stop")).toBeNull();

    gate.reject(new Error("conflict: already finished"));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    // Flush the rejection path without unhandled errors.
    await waitFor(() => expect(screen.queryByTestId("run-stop-error")).toBeNull());
    expect(screen.queryByTestId("run-stop")).toBeNull();
  });

  it("unmounts on backend-confirmed cancel without ever rendering its own Cancelled label", async () => {
    vi.spyOn(api, "cancelRun").mockResolvedValue({ runId: RUN_ID, status: "running" });
    const view = renderStop("running");

    requestStop();
    await screen.findByTestId("run-stop-requested");
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stopping…");

    view.rerender(<StopRunButton runId={RUN_ID} headStatus="cancelled" isReplay={false} />);
    expect(screen.queryByTestId("run-stop")).toBeNull();
    expect(screen.queryByTestId("run-stop-requested")).toBeNull();
    expect(screen.queryByText(/cancelled/i)).toBeNull();
  });
});

describe("StopRunButton replay vs live", () => {
  it("labels the live stop while replaying and stays enabled for a live nonterminal head", () => {
    vi.spyOn(api, "cancelRun").mockResolvedValue({ runId: RUN_ID, status: "running" });
    renderStop("running", true);
    const button = screen.getByTestId("run-stop");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Stop live run");
    expect(button).toHaveAttribute("aria-label", "Stop the live run");
    expect(button).toHaveAttribute("title", expect.stringContaining("live run"));
  });

  it("hides on a terminal live head even when replaying (head wins over the replay view)", () => {
    const cancel = vi.spyOn(api, "cancelRun");
    renderStop("failed", true);
    expect(screen.queryByTestId("run-stop")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("marks the requested note as a live-run stop while replaying", async () => {
    vi.spyOn(api, "cancelRun").mockResolvedValue({ runId: RUN_ID, status: "paused" });
    renderStop("paused", true);
    requestStop();
    expect(await screen.findByTestId("run-stop-requested")).toHaveTextContent(
      "Confirming the live run stopped…",
    );
    expect(screen.getByTestId("run-stop")).toHaveTextContent("Stopping…");
  });
});
