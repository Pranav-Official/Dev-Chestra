import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentModelPicker, catalogAgeLabel } from "../src/editor/inspector/AgentModelPicker.js";
import type { CliModelCatalog, CliModelItem } from "../src/editor/inspector/model/catalog.js";
import type { CatalogLoading } from "../src/editor/inspector/model/useCliModelCatalog.js";

const CATALOG: CliModelCatalog = {
  cli: "codex",
  projectId: "p1",
  status: "ready",
  scope: "devchestra-runtime",
  source: "codex-app-server",
  cliVersion: "1.2.3",
  items: [
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex",
      provider: "openai",
      aliases: ["gpt5c"],
      isDefault: true,
      source: "codex-app-server",
    },
    {
      id: "gpt-5",
      label: "GPT-5",
      provider: "openai",
      source: "codex-app-server",
    },
    {
      id: "claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
      provider: "anthropic",
      description: "Balanced model",
      source: "claude-sdk",
    },
  ],
  fetchedAt: Date.now() - 3 * 60_000,
  expiresAt: 2,
  truncated: false,
  customSupported: true,
};

function Harness({
  initialValue,
  catalog = CATALOG,
  error = null,
  loading = "idle",
  project = true,
  cliLabel = "Codex",
  onSelect = () => undefined,
  onUseDefault = () => undefined,
  onRefresh = () => undefined,
}: {
  initialValue?: string;
  catalog?: CliModelCatalog | null;
  error?: string | null;
  loading?: CatalogLoading;
  project?: boolean;
  cliLabel?: string;
  onSelect?: (model: string) => void;
  onUseDefault?: () => void;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | undefined>(initialValue);
  return (
    <AgentModelPicker
      id="inspector-agent-model"
      cli="codex"
      cliLabel={cliLabel}
      value={value}
      catalog={catalog}
      loading={loading}
      error={error}
      projectId={project ? "p1" : undefined}
      open={open}
      onOpenChange={setOpen}
      onSelect={(model) => {
        setValue(model);
        onSelect(model);
      }}
      onUseDefault={() => {
        setValue(undefined);
        onUseDefault();
      }}
      onRefresh={onRefresh}
    />
  );
}

function openPicker(): HTMLElement {
  fireEvent.click(screen.getByTestId("inspector-agent-model-trigger"));
  return screen.getByTestId("inspector-agent-model-picker");
}

function items(count: number): CliModelItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`,
    label: `Model ${index}`,
    source: "codex-app-server",
  }));
}

describe("AgentModelPicker trigger", () => {
  it("shows the CLI default with the provider name when no model is set", () => {
    render(<Harness />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "CLI default",
    );
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent(
      "uses Codex's own default",
    );
    expect(screen.queryByTestId("inspector-agent-model-picker")).toBeNull();
  });

  it("shows the catalog label and a muted id only when the id differs", () => {
    const { unmount } = render(<Harness initialValue="gpt-5" />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent("GPT-5");
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent("gpt-5");
    unmount();

    const bare: CliModelItem = {
      id: "claude-sonnet-4.5",
      label: "claude-sonnet-4.5",
      source: "claude-sdk",
    };
    render(<Harness initialValue="claude-sonnet-4.5" catalog={{ ...CATALOG, items: [bare] }} />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "claude-sonnet-4.5",
    );
    expect(screen.queryByTestId("inspector-agent-model-selected-id")).toBeNull();
  });

  it("labels a saved id that is not in the catalog as Custom and flags it once a catalog loaded", () => {
    const { rerender } = render(<Harness initialValue="legacy-model" catalog={null} />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent("Custom");
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent(
      "legacy-model",
    );
    expect(screen.queryByText("not in catalog")).toBeNull();

    rerender(<Harness initialValue="legacy-model" catalog={CATALOG} />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent("Custom");
    expect(screen.getByText("not in catalog")).toBeInTheDocument();
  });

  it("opens from the keyboard with ArrowDown on the trigger", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId("inspector-agent-model-trigger"), { key: "ArrowDown" });
    expect(screen.getByTestId("inspector-agent-model-listbox")).toBeInTheDocument();
  });
});

describe("AgentModelPicker popover", () => {
  it("shows the default row, model rows and a footer with count and age", () => {
    render(<Harness initialValue="gpt-5" />);
    const input = openPicker();
    expect(input).toHaveAttribute("role", "combobox");
    const listbox = screen.getByTestId("inspector-agent-model-listbox");
    expect(listbox.firstElementChild).toHaveAttribute(
      "data-testid",
      "inspector-agent-model-default",
    );
    expect(screen.getByTestId("inspector-agent-model-option-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("inspector-agent-model-status")).toHaveTextContent(
      "3 models · updated 3m ago",
    );
    expect(screen.getByTestId("inspector-agent-model-status")).toHaveAttribute(
      "title",
      "Runtime catalog · source: codex-app-server · CLI 1.2.3",
    );
    expect(screen.queryByTestId("inspector-agent-model-count")).toBeNull();
    expect(screen.queryByTestId("inspector-agent-model-source")).toBeNull();
  });

  it("keeps the default first while filtering and never commits search typing", () => {
    const onSelect = vi.fn();
    render(<Harness initialValue="gpt-5" onSelect={onSelect} />);
    const input = openPicker();
    fireEvent.change(input, { target: { value: "sonnet" } });

    expect(screen.getByTestId("inspector-agent-model-default")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-agent-model-option-0")).toHaveTextContent(
      "Claude Sonnet 4.5",
    );
    expect(screen.queryByTestId("inspector-agent-model-option-1")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves with ArrowDown and chooses with Enter", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = openPicker();
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-default").id,
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-option-0").id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("gpt-5-codex");
    expect(screen.queryByTestId("inspector-agent-model-listbox")).toBeNull();
  });

  it("supports End and Home and ArrowUp at the edges", () => {
    render(<Harness initialValue="gpt-5" />);
    const input = openPicker();
    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-option-2").id,
    );
    fireEvent.keyDown(input, { key: "Home" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-default").id,
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-default").id,
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(<Harness />);
    const input = openPicker();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("inspector-agent-model-listbox")).toBeNull());
    expect(screen.getByTestId("inspector-agent-model-trigger")).toHaveFocus();
  });

  it("closes on Tab without choosing anything", () => {
    const onSelect = vi.fn();
    const onUseDefault = vi.fn();
    render(<Harness onSelect={onSelect} onUseDefault={onUseDefault} />);
    fireEvent.keyDown(openPicker(), { key: "Tab" });
    expect(screen.queryByTestId("inspector-agent-model-listbox")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onUseDefault).not.toHaveBeenCalled();
  });

  it("chooses the default row through onUseDefault", () => {
    const onUseDefault = vi.fn();
    render(<Harness initialValue="gpt-5" onUseDefault={onUseDefault} />);
    openPicker();
    fireEvent.mouseDown(screen.getByTestId("inspector-agent-model-default"));
    fireEvent.click(screen.getByTestId("inspector-agent-model-default"));
    expect(onUseDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "CLI default",
    );
  });

  it("offers a custom row for an unmatched query and selects the trimmed text", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = openPicker();
    fireEvent.change(input, { target: { value: "  my-model  " } });
    const custom = screen.getByTestId("inspector-agent-model-custom-option");
    expect(custom).toHaveTextContent('Use "my-model" as custom model ID');
    expect(custom).not.toHaveAttribute("aria-disabled");
    fireEvent.click(custom);
    expect(onSelect).toHaveBeenCalledWith("my-model");
  });

  it("does not offer a custom row for an exact existing id", () => {
    render(<Harness />);
    fireEvent.change(openPicker(), { target: { value: "gpt-5" } });
    expect(screen.queryByTestId("inspector-agent-model-custom-option")).toBeNull();
  });

  it("disables the custom row for control characters and explains why", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.change(openPicker(), { target: { value: "bad\u0007id" } });
    const custom = screen.getByTestId("inspector-agent-model-custom-option");
    expect(custom).toHaveAttribute("aria-disabled", "true");
    expect(custom).toHaveTextContent("Model IDs cannot contain control characters.");
    fireEvent.click(custom);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId("inspector-agent-model-listbox")).toBeInTheDocument();
  });

  it("offers the custom row as the primary action when the catalog is empty", () => {
    const onSelect = vi.fn();
    render(
      <Harness catalog={{ ...CATALOG, status: "unsupported", items: [] }} onSelect={onSelect} />,
    );
    openPicker();
    expect(screen.getByText("No models to list.")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("inspector-agent-model-picker"), {
      target: { value: "typed" },
    });
    fireEvent.click(screen.getByTestId("inspector-agent-model-custom-option"));
    expect(onSelect).toHaveBeenCalledWith("typed");
  });

  it("shows no match text when nothing ranks", () => {
    render(<Harness />);
    fireEvent.change(openPicker(), { target: { value: "zzz" } });
    expect(screen.getByText("No models match.")).toBeInTheDocument();
  });

  it("groups by provider only for a multi-provider list with no search", () => {
    render(<Harness />);
    const input = openPicker();
    expect(screen.getByText("openai")).toHaveAttribute("role", "presentation");
    expect(screen.getByText("anthropic")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "gpt" } });
    expect(document.querySelectorAll(".model-picker-group")).toHaveLength(0);
  });

  it("does not group a single-provider list", () => {
    render(<Harness catalog={{ ...CATALOG, items: CATALOG.items.slice(0, 2) }} />);
    openPicker();
    expect(document.querySelectorAll(".model-picker-group")).toHaveLength(0);
  });

  it("caps rendered model rows at 200 and asks for a narrower search", () => {
    render(<Harness catalog={{ ...CATALOG, items: items(250) }} />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-option-199")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-agent-model-option-200")).toBeNull();
    expect(screen.getByText("50 more. Refine your search.")).toBeInTheDocument();
  });

  it("shows the description and aliases only on the highlighted row", () => {
    render(<Harness />);
    const input = openPicker();
    fireEvent.change(input, { target: { value: "gpt" } });
    expect(screen.queryByText(/Aliases: gpt5c/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "sonnet" } });
    expect(screen.getByText("Balanced model")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-agent-model-option-0")).toHaveAttribute(
      "title",
      "Balanced model",
    );
  });

  it("refreshes only through the footer button", () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    openPicker();
    expect(onRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("inspector-agent-model-refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables refresh while loading and shows the loading footer", () => {
    render(<Harness catalog={null} loading="load" />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-refresh")).toBeDisabled();
    expect(screen.getByTestId("inspector-agent-model-status")).toHaveTextContent("Loading models…");
  });

  it("disables refresh when there is no project", () => {
    render(<Harness project={false} catalog={null} />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-refresh")).toBeDisabled();
    expect(screen.getByTestId("inspector-agent-model-message")).toHaveTextContent(
      "Open this workflow from a project to list models. You can still type a model ID.",
    );
  });
});

describe("AgentModelPicker banners", () => {
  it("shows the stale copy and marks it as a warning", () => {
    render(<Harness catalog={{ ...CATALOG, status: "stale" }} />);
    openPicker();
    const message = screen.getByTestId("inspector-agent-model-message");
    expect(message).toHaveTextContent("Showing the saved list. It may be out of date.");
    expect(message).toHaveAttribute("data-tone", "warn");
  });

  it("shows the sign-in copy for authRequired", () => {
    render(<Harness catalog={{ ...CATALOG, status: "authRequired", items: [] }} />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-message")).toHaveTextContent(
      "Sign in to Codex to list models. You can still type a model ID.",
    );
  });

  it("shows the unavailable copy when the catalog reports it", () => {
    render(<Harness catalog={{ ...CATALOG, status: "unavailable", items: [] }} />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-message")).toHaveTextContent(
      "Couldn't load models. Type a model ID to continue.",
    );
  });

  it("shows the unavailable copy for an error with no catalog", () => {
    render(<Harness catalog={null} error="boom" />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-message")).toHaveTextContent(
      "Couldn't load models. Type a model ID to continue.",
    );
  });

  it("shows the unsupported copy with the provider name", () => {
    render(
      <Harness cliLabel="Claude Code" catalog={{ ...CATALOG, status: "unsupported", items: [] }} />,
    );
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-message")).toHaveTextContent(
      "Claude Code doesn't list models. Use the default or type a model ID.",
    );
  });

  it("puts the server message in a tooltip, not in the text", () => {
    render(
      <Harness
        catalog={{ ...CATALOG, status: "unsupported", items: [], message: "Server says no." }}
      />,
    );
    openPicker();
    const message = screen.getByTestId("inspector-agent-model-message");
    expect(message).toHaveAttribute("title", "Server says no.");
    expect(message).not.toHaveTextContent("Server says no.");
  });

  it("shows no banner when the catalog is ready", () => {
    render(<Harness />);
    openPicker();
    expect(screen.queryByTestId("inspector-agent-model-message")).toBeNull();
  });
});

describe("catalogAgeLabel", () => {
  const now = 10_000_000_000;
  it("formats minutes, hours and days", () => {
    expect(catalogAgeLabel(now - 30_000, now)).toBe("just now");
    expect(catalogAgeLabel(now - 5 * 60_000, now)).toBe("5m ago");
    expect(catalogAgeLabel(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(catalogAgeLabel(now - 2 * 24 * 60 * 60_000, now)).toBe("2d ago");
  });
});
