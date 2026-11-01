import type { ExecutionSettingsResponse } from "@devchestra/api";
import { ApiError } from "@devchestra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { SettingsPage } from "../src/pages/SettingsPage.js";
import { ExecutionPanel } from "../src/pages/settings/ExecutionPanel.js";

const EXECUTION: ExecutionSettingsResponse = {
  settings: { maxConcurrentRuns: 2, maxQueueDepth: 100 },
  limits: {
    maxConcurrentRuns: { min: 1, max: 32, default: 2 },
    maxQueueDepth: { min: 10, max: 1000, default: 100 },
  },
};

function renderWith(ui: ReactElement, path = "/settings/execution") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function concurrency(): HTMLElement {
  return screen.getByLabelText("Maximum concurrent runs");
}

function queue(): HTMLElement {
  return screen.getByLabelText("Maximum queued runs");
}

function saveLimits(): HTMLElement {
  return screen.getByRole("button", { name: "Save limits" });
}

function baseUrl(): HTMLElement {
  return screen.getByLabelText("Public base URL");
}

function saveBaseUrl(): HTMLElement {
  return screen.getByRole("button", { name: "Save base URL" });
}

beforeEach(() => {
  vi.spyOn(api, "getExecutionSettings").mockResolvedValue(EXECUTION);
  vi.spyOn(api, "getWebhookSettings").mockResolvedValue({ publicBaseUrl: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExecutionPanel limits", () => {
  it("shows the saved limits with their defaults and allowed ranges", async () => {
    renderWith(<ExecutionPanel />);
    expect(await screen.findByLabelText("Maximum concurrent runs")).toHaveValue(2);
    expect(queue()).toHaveValue(100);
    expect(screen.getByText(/Default 2; allowed 1 to 32\./u)).toBeInTheDocument();
    expect(screen.getByText(/Default 100; allowed 10 to 1000\./u)).toBeInTheDocument();
    expect(saveLimits()).toBeDisabled();
  });

  it("rejects out-of-range and partial numbers and keeps Save disabled until they are fixed", async () => {
    renderWith(<ExecutionPanel />);
    await screen.findByLabelText("Maximum concurrent runs");

    for (const value of ["0", "33", "1.5", ""]) {
      fireEvent.change(concurrency(), { target: { value } });
      expect(screen.getByText("Enter a whole number from 1 to 32.")).toBeInTheDocument();
      expect(saveLimits()).toBeDisabled();
    }
    expect(concurrency()).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(concurrency(), { target: { value: "32" } });
    expect(screen.queryByText("Enter a whole number from 1 to 32.")).toBeNull();

    fireEvent.change(queue(), { target: { value: "9" } });
    expect(screen.getByText("Enter a whole number from 10 to 1000.")).toBeInTheDocument();
    expect(saveLimits()).toBeDisabled();
  });

  it("saves valid limits through the client and confirms", async () => {
    const save = vi.spyOn(api, "saveExecutionSettings").mockResolvedValue({
      settings: { maxConcurrentRuns: 4, maxQueueDepth: 50 },
      limits: EXECUTION.limits,
    });
    renderWith(<ExecutionPanel />);
    await screen.findByLabelText("Maximum concurrent runs");

    fireEvent.change(concurrency(), { target: { value: "4" } });
    fireEvent.change(queue(), { target: { value: "50" } });
    expect(saveLimits()).toBeEnabled();
    fireEvent.click(saveLimits());

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ maxConcurrentRuns: 4, maxQueueDepth: 50 }),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(saveLimits()).toBeDisabled();
  });

  it("shows a server validation error inline", async () => {
    vi.spyOn(api, "saveExecutionSettings").mockRejectedValue(
      new ApiError("E_VALIDATION", "maxQueueDepth must be at most 1000.", 400),
    );
    renderWith(<ExecutionPanel />);
    await screen.findByLabelText("Maximum queued runs");

    fireEvent.change(queue(), { target: { value: "500" } });
    fireEvent.click(saveLimits());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("maxQueueDepth must be at most 1000.");
  });
});

describe("ExecutionPanel public base URL", () => {
  it("explains that the base URL only changes copyable webhook URLs", async () => {
    renderWith(<ExecutionPanel />);
    await screen.findByLabelText("Public base URL");
    expect(
      screen.getByText(/Only changes the copyable webhook URL that DevChestra shows/u),
    ).toBeInTheDocument();
  });

  it("rejects addresses that the server would refuse and saves a valid prefix", async () => {
    const save = vi
      .spyOn(api, "saveWebhookSettings")
      .mockResolvedValue({ publicBaseUrl: "https://hooks.example.com/prefix" });
    renderWith(<ExecutionPanel />);
    await screen.findByLabelText("Public base URL");

    fireEvent.change(baseUrl(), { target: { value: "ftp://hooks.example.com" } });
    expect(screen.getByText("Use an http:// or https:// address.")).toBeInTheDocument();
    expect(saveBaseUrl()).toBeDisabled();

    fireEvent.change(baseUrl(), { target: { value: "https://user:pw@hooks.example.com" } });
    expect(
      screen.getByText("Remove the username and password from the address."),
    ).toBeInTheDocument();

    fireEvent.change(baseUrl(), { target: { value: "https://hooks.example.com/x?a=1" } });
    expect(
      screen.getByText("Remove the query string and fragment. A path prefix is fine."),
    ).toBeInTheDocument();

    fireEvent.change(baseUrl(), { target: { value: " https://hooks.example.com/prefix " } });
    fireEvent.click(saveBaseUrl());
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ publicBaseUrl: "https://hooks.example.com/prefix" }),
    );
  });

  it("clears the base URL with null when the field is emptied", async () => {
    vi.spyOn(api, "getWebhookSettings").mockResolvedValue({
      publicBaseUrl: "https://old.example.com",
    });
    const save = vi.spyOn(api, "saveWebhookSettings").mockResolvedValue({ publicBaseUrl: null });
    renderWith(<ExecutionPanel />);
    expect(await screen.findByLabelText("Public base URL")).toHaveValue("https://old.example.com");

    fireEvent.change(baseUrl(), { target: { value: "" } });
    fireEvent.click(saveBaseUrl());
    await waitFor(() => expect(save).toHaveBeenCalledWith({ publicBaseUrl: null }));
  });
});

describe("ExecutionPanel states and route", () => {
  it("shows a loading state while the limits load", () => {
    vi.spyOn(api, "getExecutionSettings").mockReturnValue(new Promise(() => undefined));
    renderWith(<ExecutionPanel />);
    expect(screen.getByText("Loading execution settings…")).toBeInTheDocument();
  });

  it("shows an error when the limits cannot be loaded", async () => {
    vi.spyOn(api, "getExecutionSettings").mockRejectedValue(new Error("server down"));
    renderWith(<ExecutionPanel />);
    expect(
      await screen.findByText("Couldn't load execution settings. server down"),
    ).toBeInTheDocument();
  });

  it("opens the Execution section from /settings/execution", async () => {
    renderWith(<SettingsPage />, "/settings/execution");
    expect(await screen.findByRole("heading", { name: "Execution" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: "Execution" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByLabelText("Maximum concurrent runs")).toBeInTheDocument();
  });
});
