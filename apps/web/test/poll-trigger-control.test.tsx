import type { PollProbeResult, PollTriggerStatus } from "@devchestra/api";
import { ApiError } from "@devchestra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { PollTriggerControl } from "../src/editor/poll/PollTriggerControl.js";

const OFF: PollTriggerStatus = {
  supported: true,
  armed: false,
  state: "off",
  intervalSeconds: null,
  armedRevision: null,
  armedAt: null,
  nextDueAt: null,
  lastTickAt: null,
  lastOutcome: null,
  lastRunId: null,
  consecutiveFailures: 0,
  lastError: null,
  refreshError: null,
  issues: [],
};

const ARMED: PollTriggerStatus = {
  supported: true,
  armed: true,
  state: "current",
  intervalSeconds: 300,
  armedRevision: "rev-1",
  armedAt: 1_700_000_000_000,
  nextDueAt: 1_700_000_030_000,
  lastTickAt: 1_700_000_000_000,
  lastOutcome: "triggered",
  lastRunId: "run-1",
  consecutiveFailures: 0,
  lastError: null,
  refreshError: null,
  issues: [],
};

const STALE: PollTriggerStatus = { ...ARMED, state: "stale" };
const FAILING: PollTriggerStatus = {
  ...ARMED,
  state: "failing",
  lastOutcome: "failed",
  consecutiveFailures: 2,
  lastError: "exit code 1",
};
const INVALID: PollTriggerStatus = {
  ...ARMED,
  state: "invalid",
  supported: false,
  issues: [{ code: "E_POLL_PROBE", message: "Agent probes must set a prompt." }],
};

const FOUND: PollProbeResult = {
  outcome: "found",
  params: { topic: "hello" },
  dedupeKey: "abc123",
  wouldSkipAsDuplicate: false,
  error: null,
  durationMs: 123,
};

function renderControl(overrides: Partial<ComponentProps<typeof PollTriggerControl>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (props: Partial<ComponentProps<typeof PollTriggerControl>>): ReactElement => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PollTriggerControl
          projectId="p1"
          workflowId="demo"
          savedRevision={0}
          armBlockedReason={null}
          probeType="shell"
          {...props}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const result = render(element(overrides));
  return {
    ...result,
    rerenderWith: (props: Partial<ComponentProps<typeof PollTriggerControl>>) =>
      result.rerender(element({ ...overrides, ...props })),
  };
}

/** Waits for the trigger query to resolve to a state, then opens the panel. */
async function openPanel(state: string): Promise<HTMLElement> {
  const chip = await screen.findByTestId("poll-trigger-chip");
  await waitFor(() => expect(chip).toHaveAttribute("data-state", state));
  fireEvent.click(chip);
  return screen.getByTestId("poll-trigger-dialog");
}

beforeEach(() => {
  vi.spyOn(api, "getPollTrigger").mockResolvedValue(OFF);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PollTriggerControl chip", () => {
  it.each([
    ["off", OFF, "Polling off", null],
    ["current", ARMED, "Polling armed", "green"],
    ["stale", STALE, "Polling stale", "amber"],
    ["failing", FAILING, "Polling failing", "amber"],
    ["invalid", INVALID, "Polling invalid", "red"],
  ] as const)("renders the %s trigger state", async (state, status, label, tone) => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(status);
    renderControl();
    const chip = await screen.findByTestId("poll-trigger-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", state));
    expect(chip).toHaveTextContent(label);
    expect(chip).toHaveClass("pill");
    if (tone !== null) expect(chip).toHaveClass(tone);
  });

  it("refreshes the status after the saved workflow changes", async () => {
    const get = vi.spyOn(api, "getPollTrigger").mockResolvedValue(ARMED);
    const { rerenderWith } = renderControl({ savedRevision: 0 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerenderWith({ savedRevision: 1 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe("PollTriggerControl arming", () => {
  it("arms with the default 5 minute interval", async () => {
    let armed = false;
    vi.spyOn(api, "getPollTrigger").mockImplementation(async () => (armed ? ARMED : OFF));
    const arm = vi.spyOn(api, "armPollTrigger").mockImplementation(async () => {
      armed = true;
      return ARMED;
    });
    renderControl();

    const panel = await openPanel("off");
    fireEvent.click(within(panel).getByRole("button", { name: "Arm polling" }));
    await waitFor(() => expect(arm).toHaveBeenCalledWith("p1", "demo", { intervalSeconds: 300 }));
    await waitFor(() =>
      expect(screen.getByTestId("poll-trigger-chip")).toHaveAttribute("data-state", "current"),
    );
  });

  it("arms with a custom seconds interval", async () => {
    const arm = vi.spyOn(api, "armPollTrigger").mockResolvedValue({ ...ARMED, state: "current" });
    renderControl();

    const panel = await openPanel("off");
    fireEvent.change(within(panel).getByTestId("poll-interval-amount"), {
      target: { value: "30" },
    });
    fireEvent.change(within(panel).getByTestId("poll-interval-unit"), {
      target: { value: "seconds" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Arm polling" }));
    await waitFor(() => expect(arm).toHaveBeenCalledWith("p1", "demo", { intervalSeconds: 30 }));
  });

  it("enforces the 60s agent minimum and blocks arming below it", async () => {
    const arm = vi.spyOn(api, "armPollTrigger");
    renderControl({ probeType: "agent" });
    const panel = await openPanel("off");
    expect(within(panel).getByText("Minimum 60 seconds for agent probes.")).toBeInTheDocument();
    fireEvent.change(within(panel).getByTestId("poll-interval-amount"), {
      target: { value: "30" },
    });
    fireEvent.change(within(panel).getByTestId("poll-interval-unit"), {
      target: { value: "seconds" },
    });
    const button = within(panel).getByRole("button", { name: "Arm polling" });
    expect(button).toBeDisabled();
    expect(
      within(panel).getByText("The interval must be at least 60 seconds for agent probes."),
    ).toBeVisible();
    expect(arm).not.toHaveBeenCalled();
  });

  it("shows the 10s shell minimum", async () => {
    renderControl({ probeType: "shell" });
    const panel = await openPanel("off");
    expect(within(panel).getByText("Minimum 10 seconds for shell probes.")).toBeInTheDocument();
  });

  it("disarms only after confirmation", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(ARMED);
    const disarm = vi.spyOn(api, "disarmPollTrigger").mockResolvedValue(OFF);
    renderControl();
    const panel = await openPanel("current");
    fireEvent.click(within(panel).getByRole("button", { name: "Disarm polling" }));
    const confirm = await screen.findByRole("dialog", { name: "Disarm the polling trigger?" });
    expect(disarm).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Disarm polling" }));
    await waitFor(() => expect(disarm).toHaveBeenCalledWith("p1", "demo"));
  });

  it("starts the interval form from the armed interval and keeps a person's edit", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue({ ...ARMED, intervalSeconds: 90 });
    renderControl();
    const panel = await openPanel("current");
    const amount = within(panel).getByTestId("poll-interval-amount") as HTMLInputElement;
    await waitFor(() => expect(amount.value).toBe("90"));
    expect(within(panel).getByTestId("poll-interval-unit")).toHaveValue("seconds");
    fireEvent.change(amount, { target: { value: "120" } });
    expect(amount.value).toBe("120");
  });

  it("starts the interval form in minutes when the armed interval is whole minutes", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue({ ...ARMED, intervalSeconds: 600 });
    renderControl();
    const panel = await openPanel("current");
    await waitFor(() =>
      expect((within(panel).getByTestId("poll-interval-amount") as HTMLInputElement).value).toBe(
        "10",
      ),
    );
    expect(within(panel).getByTestId("poll-interval-unit")).toHaveValue("minutes");
  });

  it("updates the interval while armed", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(ARMED);
    const arm = vi.spyOn(api, "armPollTrigger").mockResolvedValue(ARMED);
    renderControl();
    const panel = await openPanel("current");
    fireEvent.change(within(panel).getByTestId("poll-interval-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Update interval" }));
    await waitFor(() => expect(arm).toHaveBeenCalledWith("p1", "demo", { intervalSeconds: 600 }));
  });

  it("blocks arming while the editor has unsaved edits and says to save first", async () => {
    const arm = vi.spyOn(api, "armPollTrigger");
    renderControl({ armBlockedReason: "Save your changes first. Arming uses the saved file." });
    const panel = await openPanel("off");
    const button = within(panel).getByRole("button", { name: "Arm polling" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Save your changes first. Arming uses the saved file.",
    );
    expect(arm).not.toHaveBeenCalled();
  });

  it("blocks arming when the saved workflow does not accept polling", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue({ ...OFF, supported: false });
    renderControl();
    const panel = await openPanel("off");
    expect(within(panel).getByRole("button", { name: "Arm polling" })).toBeDisabled();
    expect(
      within(panel).getByText("Turn on Accept polling triggers in the Start node, then save."),
    ).toBeVisible();
  });
});

describe("PollTriggerControl after arming", () => {
  it("offers Refresh armed revision only when the armed revision is stale", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(ARMED);
    const { unmount } = renderControl();
    let panel = await openPanel("current");
    expect(within(panel).queryByRole("button", { name: "Refresh armed revision" })).toBeNull();
    unmount();

    vi.spyOn(api, "getPollTrigger").mockResolvedValue(STALE);
    renderControl();
    panel = await openPanel("stale");
    const refreshCall = vi.spyOn(api, "refreshPollTrigger").mockResolvedValue(ARMED);
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh armed revision" }));
    await waitFor(() => expect(refreshCall).toHaveBeenCalledWith("p1", "demo"));
  });

  it("shows the saved-file issues and says the last valid revision keeps running when invalid", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(INVALID);
    renderControl();
    const panel = await openPanel("invalid");
    expect(
      within(panel).getByText("The last valid armed revision keeps running.", { exact: false }),
    ).toBeVisible();
    const issues = within(panel).getByRole("region", { name: "Saved workflow issues" });
    expect(within(issues).getByText("Agent probes must set a prompt.")).toBeVisible();
  });

  it("shows the refresh error recorded by the last automatic refresh", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue({
      ...ARMED,
      refreshError: "Parameter 'topic' is missing a mapping.",
    });
    renderControl();
    const panel = await openPanel("current");
    expect(within(panel).getByRole("alert")).toHaveTextContent(
      "The last automatic refresh failed: Parameter 'topic' is missing a mapping.",
    );
  });

  it("reports a failed refresh with the validation issues it returned", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(STALE);
    vi.spyOn(api, "refreshPollTrigger").mockRejectedValue(
      new ApiError("E_WORKFLOW_INVALID", "The saved workflow is invalid.", 400, {
        issues: [{ code: "E_POLL_PROBE", message: "Probe command is empty." }],
      }),
    );
    renderControl();
    const panel = await openPanel("stale");
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh armed revision" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("The saved workflow is invalid.");
    expect(alert).toHaveTextContent("E_POLL_PROBE");
    expect(alert).toHaveTextContent("Probe command is empty.");
  });

  it("shows the last check, outcome, last run link and failure counts", async () => {
    vi.spyOn(api, "getPollTrigger").mockResolvedValue(ARMED);
    renderControl();
    const panel = await openPanel("current");
    const facts = within(panel).getByText("Last check").closest("dl");
    expect(facts).toHaveTextContent("Last outcome");
    expect(facts).toHaveTextContent("triggered");
    expect(facts).toHaveTextContent("Consecutive failures");
    const link = within(panel).getByRole("link", { name: "run-1" });
    expect(link).toHaveAttribute("href", "/p/p1/r/run-1");
  });

  it("always says that manual runs stay available and polling needs the server", async () => {
    renderControl();
    const panel = await openPanel("off");
    expect(
      within(panel).getByText(/Manual runs stay available whether or not the trigger is armed/u),
    ).toBeVisible();
    expect(
      within(panel).getByText("Polling only runs while the DevChestra server is running."),
    ).toBeVisible();
  });
});

describe("PollTriggerControl probe-now", () => {
  it("shows found params, the dedupe key and labels the run as not started", async () => {
    vi.spyOn(api, "probePollTrigger").mockResolvedValue(FOUND);
    renderControl();
    const panel = await openPanel("off");
    fireEvent.click(within(panel).getByRole("button", { name: "Test probe now" }));
    const result = await within(panel).findByRole("region", { name: "Probe result" });
    expect(within(panel).getByText("Runs it once. Never starts a workflow run.")).toBeVisible();
    expect(within(result).getByTestId("poll-probe-params")).toHaveTextContent("hello");
    expect(within(result).getByText("abc123")).toBeVisible();
    expect(within(result).getByText("Took 123 ms.")).toBeVisible();
  });

  it("flags a result that a real tick would skip as a repeat", async () => {
    vi.spyOn(api, "probePollTrigger").mockResolvedValue({ ...FOUND, wouldSkipAsDuplicate: true });
    renderControl();
    const panel = await openPanel("off");
    fireEvent.click(within(panel).getByRole("button", { name: "Test probe now" }));
    const result = await within(panel).findByRole("region", { name: "Probe result" });
    expect(
      within(result).getByText("A real tick would skip this result as a repeat."),
    ).toBeVisible();
  });

  it("shows a probe that found nothing", async () => {
    vi.spyOn(api, "probePollTrigger").mockResolvedValue({
      outcome: "nothing",
      params: null,
      dedupeKey: null,
      wouldSkipAsDuplicate: false,
      error: null,
      durationMs: 45,
    });
    renderControl();
    const panel = await openPanel("off");
    fireEvent.click(within(panel).getByRole("button", { name: "Test probe now" }));
    const result = await within(panel).findByRole("region", { name: "Probe result" });
    expect(within(result).getByText("No run would start: the probe found nothing.")).toBeVisible();
  });

  it("shows a failed probe error", async () => {
    vi.spyOn(api, "probePollTrigger").mockResolvedValue({
      outcome: "failed",
      params: null,
      dedupeKey: null,
      wouldSkipAsDuplicate: false,
      error: "exit code 1: boom",
      durationMs: 12,
    });
    renderControl();
    const panel = await openPanel("off");
    fireEvent.click(within(panel).getByRole("button", { name: "Test probe now" }));
    const result = await within(panel).findByRole("region", { name: "Probe result" });
    expect(within(result).getByRole("alert")).toHaveTextContent("exit code 1: boom");
  });
});
