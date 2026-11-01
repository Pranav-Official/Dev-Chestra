import type { WebhookTriggerStatus } from "@devchestra/api";
import { ApiError } from "@devchestra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { WebhookTriggerControl } from "../src/editor/webhook/WebhookTriggerControl.js";

const OFF: WebhookTriggerStatus = {
  supported: true,
  armed: false,
  state: "off",
  hookId: null,
  url: null,
  armedRevision: null,
  armedAt: null,
  lastDeliveryAt: null,
  refreshError: null,
  issues: [],
};

const ARMED: WebhookTriggerStatus = {
  supported: true,
  armed: true,
  state: "current",
  hookId: "whk_test",
  url: "http://localhost:4899/webhooks/whk_test",
  armedRevision: "rev-1",
  armedAt: 1_700_000_000_000,
  lastDeliveryAt: null,
  refreshError: null,
  issues: [],
};

const STALE: WebhookTriggerStatus = { ...ARMED, state: "stale" };

const INVALID: WebhookTriggerStatus = {
  ...ARMED,
  state: "invalid",
  supported: false,
  issues: [
    {
      code: "E_WEBHOOK_MAPPING",
      message: "Webhook mapping targets undeclared parameter 'ghost'.",
    },
  ],
};

const FIRST_SECRETS = { bearerToken: "dcwh_first", signingSecret: "dcws_first" };
const ROTATED_SECRETS = { bearerToken: "dcwh_rotated", signingSecret: "dcws_rotated" };

function renderControl(overrides: Partial<ComponentProps<typeof WebhookTriggerControl>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (props: Partial<ComponentProps<typeof WebhookTriggerControl>>): ReactElement => (
    <QueryClientProvider client={client}>
      <WebhookTriggerControl
        projectId="p1"
        workflowId="demo"
        savedRevision={0}
        armBlockedReason={null}
        {...props}
      />
    </QueryClientProvider>
  );
  const result = render(element(overrides));
  return {
    ...result,
    rerenderWith: (props: Partial<ComponentProps<typeof WebhookTriggerControl>>) =>
      result.rerender(element({ ...overrides, ...props })),
  };
}

/** Waits for the trigger query to resolve to a state, then opens the panel. */
async function openPanel(state: string): Promise<HTMLElement> {
  const chip = await screen.findByTestId("webhook-trigger-chip");
  await waitFor(() => expect(chip).toHaveAttribute("data-state", state));
  fireEvent.click(chip);
  return screen.getByTestId("webhook-trigger-dialog");
}

function isOpen(testId: string): boolean {
  return screen.getByTestId(testId).hasAttribute("open");
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

beforeEach(() => {
  vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(OFF);
});

describe("WebhookTriggerControl chip", () => {
  it.each([
    ["off", OFF, "Webhook off", null],
    ["current", ARMED, "Webhook armed", "green"],
    ["stale", STALE, "Webhook stale", "amber"],
    ["invalid", INVALID, "Webhook invalid", "red"],
  ] as const)("renders the %s trigger state", async (state, status, label, tone) => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(status);
    renderControl();
    const chip = await screen.findByTestId("webhook-trigger-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", state));
    expect(chip).toHaveTextContent(label);
    expect(chip).toHaveClass("pill");
    if (tone !== null) expect(chip).toHaveClass(tone);
  });

  it("refreshes the status after the saved workflow changes", async () => {
    const get = vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(ARMED);
    const { rerenderWith } = renderControl({ savedRevision: 0 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerenderWith({ savedRevision: 1 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe("WebhookTriggerControl arming", () => {
  it("arms through the client and shows the secrets dialog once", async () => {
    let armed = false;
    vi.spyOn(api, "getWebhookTrigger").mockImplementation(async () => (armed ? ARMED : OFF));
    // The first arm creates the secrets; a later arm reuses them, so the server returns none.
    const arm = vi
      .spyOn(api, "armWebhookTrigger")
      .mockImplementationOnce(async () => {
        armed = true;
        return { status: ARMED, secrets: FIRST_SECRETS };
      })
      .mockImplementationOnce(async () => {
        armed = true;
        return { status: ARMED, secrets: null };
      });
    const disarm = vi.spyOn(api, "disarmWebhookTrigger").mockImplementation(async () => {
      armed = false;
      return OFF;
    });
    renderControl();

    let panel = await openPanel("off");
    expect(panel).toHaveAttribute("open");
    fireEvent.click(within(panel).getByRole("button", { name: "Arm webhook" }));

    await waitFor(() => expect(arm).toHaveBeenCalledWith("p1", "demo"));
    await waitFor(() => expect(isOpen("webhook-secrets-dialog")).toBe(true));
    expect(screen.getByTestId("webhook-secret-bearer")).toHaveValue("dcwh_first");
    expect(screen.getByTestId("webhook-secret-signing")).toHaveValue("dcws_first");
    expect(screen.getByText("They are shown once and will not be shown again.")).toBeVisible();
    expect(isOpen("webhook-trigger-dialog")).toBe(false);

    fireEvent.click(
      within(screen.getByTestId("webhook-secrets-dialog")).getByRole("button", { name: "Done" }),
    );
    await waitFor(() => expect(isOpen("webhook-secrets-dialog")).toBe(false));
    expect(screen.queryByTestId("webhook-secret-bearer")).toBeNull();

    panel = await openPanel("current");
    fireEvent.click(within(panel).getByRole("button", { name: "Disarm webhook" }));
    await waitFor(() => expect(disarm).toHaveBeenCalledWith("p1", "demo"));

    panel = await openPanel("off");
    fireEvent.click(within(panel).getByRole("button", { name: "Arm webhook" }));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("webhook-trigger-chip")).toHaveAttribute("data-state", "current"),
    );
    expect(isOpen("webhook-secrets-dialog")).toBe(false);
    expect(screen.queryByTestId("webhook-secret-bearer")).toBeNull();
  });

  it("disarms through the client", async () => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(ARMED);
    const disarm = vi.spyOn(api, "disarmWebhookTrigger").mockResolvedValue(OFF);
    renderControl();
    const panel = await openPanel("current");
    fireEvent.click(within(panel).getByRole("button", { name: "Disarm webhook" }));
    await waitFor(() => expect(disarm).toHaveBeenCalledWith("p1", "demo"));
  });

  it("blocks arming while the editor has unsaved edits and says to save first", async () => {
    const arm = vi.spyOn(api, "armWebhookTrigger");
    renderControl({ armBlockedReason: "Save your changes first. Arming uses the saved file." });
    const panel = await openPanel("off");
    const button = within(panel).getByRole("button", { name: "Arm webhook" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Save your changes first. Arming uses the saved file.",
    );
    expect(arm).not.toHaveBeenCalled();
  });

  it("blocks arming when the saved workflow does not accept webhooks", async () => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue({ ...OFF, supported: false });
    renderControl();
    const panel = await openPanel("off");
    expect(within(panel).getByRole("button", { name: "Arm webhook" })).toBeDisabled();
    expect(
      within(panel).getByText("Turn on Accept webhook triggers in the Start node, then save."),
    ).toBeVisible();
  });
});

describe("WebhookTriggerControl after arming", () => {
  it("offers Refresh armed revision only when the armed revision is stale", async () => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(ARMED);
    const { unmount } = renderControl();
    let panel = await openPanel("current");
    expect(within(panel).queryByRole("button", { name: "Refresh armed revision" })).toBeNull();
    unmount();

    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(STALE);
    renderControl();
    panel = await openPanel("stale");
    const refresh = within(panel).getByRole("button", { name: "Refresh armed revision" });
    const refreshCall = vi.spyOn(api, "refreshWebhookTrigger").mockResolvedValue(ARMED);
    fireEvent.click(refresh);
    await waitFor(() => expect(refreshCall).toHaveBeenCalledWith("p1", "demo"));
  });

  it("shows the saved-file issues and says the last valid revision keeps running when invalid", async () => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(INVALID);
    renderControl();
    const panel = await openPanel("invalid");
    expect(
      within(panel).getByText("The last valid armed revision keeps running.", { exact: false }),
    ).toBeVisible();
    const issues = within(panel).getByRole("region", { name: "Saved workflow issues" });
    expect(
      within(issues).getByText("Webhook mapping targets undeclared parameter 'ghost'."),
    ).toBeVisible();
  });

  it("shows the refresh error recorded by the last automatic refresh", async () => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue({
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
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(STALE);
    vi.spyOn(api, "refreshWebhookTrigger").mockRejectedValue(
      new ApiError("E_WORKFLOW_INVALID", "The saved workflow is invalid.", 400, {
        issues: [{ code: "E_PARAM_NAME", message: "Parameter name 'a-b' is not allowed." }],
      }),
    );
    renderControl();
    const panel = await openPanel("stale");
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh armed revision" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("The saved workflow is invalid.");
    expect(alert).toHaveTextContent("E_PARAM_NAME");
    expect(alert).toHaveTextContent("Parameter name 'a-b' is not allowed.");
  });

  it("rotates secrets only after confirmation and shows the new ones once", async () => {
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(ARMED);
    const rotate = vi
      .spyOn(api, "rotateWebhookTrigger")
      .mockResolvedValue({ status: ARMED, secrets: ROTATED_SECRETS });
    renderControl();
    const panel = await openPanel("current");

    fireEvent.click(within(panel).getByRole("button", { name: "Rotate secrets" }));
    const confirm = await screen.findByRole("dialog", { name: "Rotate webhook secrets?" });
    expect(
      within(confirm).getByText(
        /The current bearer token and signing secret stop working immediately/u,
      ),
    ).toBeVisible();
    expect(rotate).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Rotate secrets" }));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith("p1", "demo"));
    await waitFor(() => expect(isOpen("webhook-secrets-dialog")).toBe(true));
    expect(screen.getByTestId("webhook-secret-bearer")).toHaveValue("dcwh_rotated");
  });

  it("copies the delivery URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(api, "getWebhookTrigger").mockResolvedValue(ARMED);
    renderControl();
    const panel = await openPanel("current");
    expect(within(panel).getByTestId("webhook-url")).toHaveValue(ARMED.url ?? "");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ARMED.url));
    expect(within(panel).getByRole("button", { name: "Copy URL" })).toHaveTextContent("Copied");
  });

  it("always says that manual runs stay available", async () => {
    renderControl();
    const panel = await openPanel("off");
    expect(
      within(panel).getByText(/Manual runs stay available whether or not the trigger is armed/u),
    ).toBeVisible();
  });
});
