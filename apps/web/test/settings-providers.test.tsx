import type { CliListItem, ProviderStatusItem } from "@devchestra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { SettingsPage } from "../src/pages/SettingsPage.js";
import { ProvidersPanel } from "../src/pages/settings/ProvidersPanel.js";

const OFF_TEXT = "Off: hidden from agent nodes; runs that use it are blocked.";
const LAST_ON_TEXT = "At least one provider must stay on";

const CLIS: CliListItem[] = [
  { id: "claude-code", label: "Claude Code", experimental: false, enabled: true },
  { id: "codex", label: "Codex", experimental: false, enabled: true },
  { id: "opencode", label: "Opencode", experimental: false, enabled: true },
  { id: "pi", label: "Pi", experimental: false, enabled: true },
];

const STATUSES: ProviderStatusItem[] = [
  { id: "claude-code", state: "ready", version: "1.2.3", checkedAt: 1 },
  {
    id: "codex",
    state: "notInstalled",
    version: null,
    detail: "codex was not found on PATH",
    checkedAt: 1,
  },
  { id: "opencode", state: "error", version: null, detail: "exited with code 2", checkedAt: 1 },
  { id: "pi", state: "unknown", version: null, checkedAt: 1 },
];

function renderWith(ui: ReactElement, path = "/settings/providers") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(id: string) {
  return screen.getByTestId(`provider-row-${id}`);
}

function listClis(clis: CliListItem[]) {
  vi.spyOn(api, "listClis").mockResolvedValue({ clis });
}

beforeEach(() => {
  listClis(CLIS);
  vi.spyOn(api, "listCliStatus").mockResolvedValue({ statuses: STATUSES });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProvidersPanel", () => {
  it("renders the four providers in order with their labels", async () => {
    renderWith(<ProvidersPanel />);
    const list = await screen.findByRole("list", { name: "Providers" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
      "provider-row-claude-code",
      "provider-row-codex",
      "provider-row-opencode",
      "provider-row-pi",
    ]);
    expect(within(row("claude-code")).getByText("Claude Code")).toBeInTheDocument();
    expect(within(row("codex")).getByText("Codex")).toBeInTheDocument();
    expect(within(row("opencode")).getByText("Opencode")).toBeInTheDocument();
    expect(within(row("pi")).getByText("Pi")).toBeInTheDocument();
  });

  it("shows a status chip for ready, not installed, error and unknown", async () => {
    renderWith(<ProvidersPanel />);
    expect(await screen.findByTestId("provider-status-claude-code")).toHaveTextContent(
      /^Ready · v1\.2\.3$/u,
    );
    expect(screen.getByTestId("provider-status-codex")).toHaveTextContent(/^Not installed$/u);
    expect(screen.getByTestId("provider-status-opencode")).toHaveTextContent(/^Check failed$/u);
    expect(screen.getByTestId("provider-status-pi")).toHaveTextContent(/^Unknown$/u);
    expect(within(row("codex")).getByText("codex was not found on PATH")).toBeInTheDocument();
  });

  it("shows Unknown for every provider when the status call fails", async () => {
    vi.spyOn(api, "listCliStatus").mockRejectedValue(new Error("status down"));
    renderWith(<ProvidersPanel />);
    for (const id of ["claude-code", "codex", "opencode", "pi"]) {
      await waitFor(() =>
        expect(screen.getByTestId(`provider-status-${id}`)).toHaveTextContent(/^Unknown$/u),
      );
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("turns a provider off straight away and calls the API", async () => {
    vi.spyOn(api, "setCliEnabled").mockReturnValue(new Promise(() => undefined));
    renderWith(<ProvidersPanel />);
    fireEvent.click(await screen.findByRole("switch", { name: "Turn off Codex" }));
    await waitFor(() =>
      expect(api.setCliEnabled).toHaveBeenCalledWith("codex", { enabled: false }),
    );
    await screen.findByRole("switch", { name: "Turn on Codex" });
    expect(row("codex")).toHaveTextContent(OFF_TEXT);
    expect(row("codex")).not.toHaveTextContent("codex was not found on PATH");
  });

  it("rolls the switch back and shows the error when the change fails", async () => {
    vi.spyOn(api, "setCliEnabled").mockRejectedValue(new Error("Could not save the change."));
    renderWith(<ProvidersPanel />);
    fireEvent.click(await screen.findByRole("switch", { name: "Turn off Codex" }));
    const alert = await within(row("codex")).findByRole("alert");
    expect(alert).toHaveTextContent("Could not save the change.");
    expect(screen.getByRole("switch", { name: "Turn off Codex" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(row("codex")).not.toHaveTextContent(OFF_TEXT);
  });

  it("disables the switch of the only enabled provider", async () => {
    listClis([
      { id: "claude-code", label: "Claude Code", experimental: false, enabled: true },
      { id: "codex", label: "Codex", experimental: false, enabled: false },
      { id: "opencode", label: "Opencode", experimental: false, enabled: false },
      { id: "pi", label: "Pi", experimental: false, enabled: false },
    ]);
    renderWith(<ProvidersPanel />);
    const last = await screen.findByRole("switch", { name: "Turn off Claude Code" });
    expect(last).toBeDisabled();
    expect(last).toHaveAttribute("title", LAST_ON_TEXT);
    expect(screen.getByRole("switch", { name: "Turn on Codex" })).toBeEnabled();
  });

  it("re-tests one provider and updates its chip", async () => {
    vi.spyOn(api, "probeCli").mockResolvedValue({
      id: "codex",
      state: "ready",
      version: "0.9.0",
      checkedAt: 2,
    });
    renderWith(<ProvidersPanel />);
    expect(await screen.findByTestId("provider-status-codex")).toHaveTextContent(
      /^Not installed$/u,
    );
    fireEvent.click(screen.getByRole("button", { name: "Re-test Codex" }));
    await waitFor(() =>
      expect(screen.getByTestId("provider-status-codex")).toHaveTextContent(/^Ready · v0\.9\.0$/u),
    );
    expect(api.probeCli).toHaveBeenCalledWith("codex");
  });

  it("shows a banner and disables the controls when the API is unreachable", async () => {
    vi.spyOn(api, "listClis").mockRejectedValue(new Error("Network down"));
    renderWith(<ProvidersPanel />);
    expect(
      await screen.findByText("Couldn't reach DevChestra. Showing defaults; changes are disabled."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "Turn off Claude Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Re-test Codex" })).toBeDisabled();
  });
});

describe("SettingsPage providers route", () => {
  it("shows the providers panel with Usage before Providers in the nav", async () => {
    renderWith(<SettingsPage />, "/settings/providers");
    expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Usage", "Providers", "Execution"]);
    expect(links[1]).toHaveAttribute("aria-current", "page");
    expect(links[0]).not.toHaveAttribute("aria-current");
  });

  it("keeps /settings/usage on the usage panel, not the providers panel", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => undefined));
    renderWith(<SettingsPage />, "/settings/usage");
    expect(await screen.findByText("Loading usage…")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/usage", expect.anything());
    expect(screen.queryByRole("list", { name: "Providers" })).toBeNull();
    expect(api.listClis).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: "Usage" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
