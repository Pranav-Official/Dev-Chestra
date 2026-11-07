import {
  ApiError,
  type EffectiveSettingsResponse,
  type SettingsDocument,
  type SettingsResponse,
  type SettingsScopeValue,
} from "@devchestra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { ModelsPanel } from "../src/pages/settings/ModelsPanel.js";
import { SETTINGS_SECTIONS } from "../src/pages/settings/sections.js";

const ETAG_A = "a".repeat(64);
const ETAG_B = "b".repeat(64);
const ETAG_C = "c".repeat(64);

function layer(
  scope: SettingsScopeValue,
  document: SettingsDocument,
  etag: string,
  exists = document.models !== undefined,
): SettingsResponse {
  return { scope, document, etag, exists, warnings: [] };
}

const EFFECTIVE: EffectiveSettingsResponse = {
  tiers: [
    { tier: "high", mapping: { ref: { cli: "claude-code", model: "opus" }, source: "local" } },
    { tier: "medium", mapping: { ref: { cli: "codex" }, source: "project" } },
    { tier: "low", mapping: null },
  ],
};

function renderPanel(path = "/p/p1/settings/models") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:pid/settings/models" element={<ModelsPanel />} />
          <Route path="/settings/models" element={<ModelsPanel />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function cliSelect(scope: SettingsScopeValue, tier: string): HTMLSelectElement {
  return screen.getByTestId(`settings-tier-cli-${scope}-${tier}`) as HTMLSelectElement;
}

beforeEach(() => {
  vi.spyOn(api, "getEffectiveSettings").mockResolvedValue(EFFECTIVE);
  vi.spyOn(api, "getSettings").mockImplementation(async (_pid, scope) =>
    scope === "local"
      ? layer(
          "local",
          { version: 1, models: { high: { cli: "claude-code", model: "opus" } } },
          ETAG_A,
        )
      : layer("project", { version: 1 }, ETAG_B, false),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ModelsPanel", () => {
  it("is listed among the settings sections", () => {
    expect(SETTINGS_SECTIONS.map((entry) => entry.id)).toContain("models");
  });

  it("asks for a project when none is open", () => {
    renderPanel("/settings/models");
    expect(screen.getByTestId("models-no-project")).toBeInTheDocument();
    expect(api.getSettings).not.toHaveBeenCalled();
  });

  it("explains the two files and shows what each tier resolves to here", async () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Model tiers" })).toBeInTheDocument();
    const local = await screen.findByTestId("settings-scope-local");
    expect(within(local).getByText(".devchestra/settings.local.json")).toBeInTheDocument();
    expect(within(local).getByText(/Git ignores the file/)).toBeInTheDocument();
    const shared = screen.getByTestId("settings-scope-project");
    expect(within(shared).getByText(".devchestra/settings.json")).toBeInTheDocument();

    const summary = await screen.findByTestId("settings-effective");
    await within(summary).findByTestId("settings-effective-high");
    expect(within(summary).getByTestId("settings-effective-high")).toHaveTextContent(
      "Claude Code · opus",
    );
    expect(within(summary).getByTestId("settings-effective-high")).toHaveTextContent(
      "This machine",
    );
    expect(within(summary).getByTestId("settings-effective-medium")).toHaveTextContent(
      "Project settings",
    );
    expect(within(summary).getByTestId("settings-effective-low")).toHaveTextContent("Not set");
  });

  it("loads each file into its own rows", async () => {
    renderPanel();
    await screen.findByTestId("settings-tier-local-high");
    expect(cliSelect("local", "high").value).toBe("claude-code");
    expect(cliSelect("local", "medium").value).toBe("");
    expect(cliSelect("project", "high").value).toBe("");
    expect(screen.getByTestId("settings-tier-model-local-high")).toHaveTextContent("opus");
  });

  it("keeps Save off until something changes, then saves with the loaded ETag", async () => {
    const saved = layer(
      "local",
      { version: 1, models: { high: { cli: "claude-code", model: "opus" }, low: { cli: "pi" } } },
      ETAG_C,
    );
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(saved);
    renderPanel();
    await screen.findByTestId("settings-tier-local-low");
    const button = screen.getByTestId("settings-scope-local-save");
    expect(button).toBeDisabled();

    fireEvent.change(cliSelect("local", "low"), { target: { value: "pi" } });
    expect(button).toBeEnabled();
    expect(screen.getByTestId("settings-scope-local-status")).toHaveTextContent("Unsaved changes");
    fireEvent.click(button);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      "p1",
      "local",
      { version: 1, models: { high: { cli: "claude-code", model: "opus" }, low: { cli: "pi" } } },
      ETAG_A,
    );
    await waitFor(() =>
      expect(screen.getByTestId("settings-scope-local-status")).toHaveTextContent("Saved."),
    );
    expect(screen.getByTestId("settings-scope-local-save")).toBeDisabled();
  });

  it("clearing every tier saves an empty document so the file is removed", async () => {
    const save = vi
      .spyOn(api, "saveSettings")
      .mockResolvedValue(layer("local", { version: 1 }, ETAG_C, false));
    renderPanel();
    await screen.findByTestId("settings-tier-local-high");
    fireEvent.change(cliSelect("local", "high"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("settings-scope-local-save"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith("p1", "local", { version: 1 }, ETAG_A);
  });

  it("drops the model when the provider changes", async () => {
    const save = vi
      .spyOn(api, "saveSettings")
      .mockResolvedValue(
        layer("local", { version: 1, models: { high: { cli: "codex" } } }, ETAG_C),
      );
    renderPanel();
    await screen.findByTestId("settings-tier-local-high");
    fireEvent.change(cliSelect("local", "high"), { target: { value: "codex" } });
    fireEvent.click(screen.getByTestId("settings-scope-local-save"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(
      "p1",
      "local",
      { version: 1, models: { high: { cli: "codex" } } },
      ETAG_A,
    );
  });

  it("discards edits", async () => {
    renderPanel();
    await screen.findByTestId("settings-tier-local-medium");
    fireEvent.change(cliSelect("local", "medium"), { target: { value: "codex" } });
    const card = screen.getByTestId("settings-scope-local");
    fireEvent.click(within(card).getByRole("button", { name: "Discard" }));
    expect(cliSelect("local", "medium").value).toBe("");
    expect(screen.getByTestId("settings-scope-local-save")).toBeDisabled();
  });

  it("explains a conflict and reloads the file from disk", async () => {
    vi.spyOn(api, "saveSettings").mockRejectedValue(
      new ApiError("E_CONFLICT", "settings.local.json changed on disk.", 409),
    );
    renderPanel();
    await screen.findByTestId("settings-tier-local-medium");
    fireEvent.change(cliSelect("local", "medium"), { target: { value: "codex" } });
    fireEvent.click(screen.getByTestId("settings-scope-local-save"));

    const conflict = await screen.findByTestId("settings-scope-local-conflict");
    expect(conflict).toHaveTextContent("changed on disk");

    vi.mocked(api.getSettings).mockImplementation(async (_pid, scope) =>
      scope === "local"
        ? layer("local", { version: 1, models: { medium: { cli: "pi" } } }, ETAG_C)
        : layer("project", { version: 1 }, ETAG_B, false),
    );
    fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(cliSelect("local", "medium").value).toBe("pi"));
    expect(screen.queryByTestId("settings-scope-local-conflict")).toBeNull();
  });

  it("reports a failed save without calling it a conflict", async () => {
    vi.spyOn(api, "saveSettings").mockRejectedValue(
      new ApiError("E_INTERNAL", "The disk is full.", 500),
    );
    renderPanel();
    await screen.findByTestId("settings-tier-project-high");
    fireEvent.change(cliSelect("project", "high"), { target: { value: "codex" } });
    fireEvent.click(screen.getByTestId("settings-scope-project-save"));
    expect(await screen.findByText(/Couldn't save\. The disk is full\./)).toBeInTheDocument();
    expect(screen.queryByTestId("settings-scope-project-conflict")).toBeNull();
  });

  it("offers a retry when a file cannot be loaded", async () => {
    vi.mocked(api.getSettings).mockImplementation(async (_pid, scope) => {
      if (scope === "local")
        throw new ApiError("E_VALIDATION", "settings.local.json is not valid.", 400);
      return layer("project", { version: 1 }, ETAG_B, false);
    });
    renderPanel();
    const local = await screen.findByTestId("settings-scope-local");
    expect(
      await within(local).findByText(/Couldn't load \.devchestra\/settings\.local\.json/),
    ).toBeInTheDocument();
    expect(within(local).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-tier-project-high")).toBeInTheDocument();
  });
});
