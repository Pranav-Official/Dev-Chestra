import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentModelPicker } from "../src/editor/inspector/AgentModelPicker.js";
import type { CliModelCatalog } from "../src/editor/inspector/model/catalog.js";

const CATALOG: CliModelCatalog = {
  cli: "codex",
  projectId: "p1",
  status: "ready",
  scope: "relay-runtime",
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
  fetchedAt: 1,
  expiresAt: 2,
  truncated: false,
  customSupported: true,
};

function Harness({
  initialValue,
  catalog = CATALOG,
  error = null,
}: {
  initialValue?: string;
  catalog?: CliModelCatalog | null;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | undefined>(initialValue);
  const [calls, setCalls] = useState<string[]>([]);
  const [refreshes, setRefreshes] = useState(0);
  return (
    <div>
      <AgentModelPicker
        id="inspector-agent-model"
        value={value}
        catalog={catalog}
        loading="idle"
        error={error}
        projectId="p1"
        open={open}
        onOpenChange={setOpen}
        onSelect={(model) => {
          setValue(model);
          setCalls((previous) => [...previous, `select:${model}`]);
        }}
        onUseDefault={() => {
          setValue(undefined);
          setCalls((previous) => [...previous, "default"]);
        }}
        onRefresh={() => setRefreshes((previous) => previous + 1)}
      />
      <pre data-testid="calls">{JSON.stringify(calls)}</pre>
      <span data-testid="refreshes">{refreshes}</span>
    </div>
  );
}

function calls(): string[] {
  return JSON.parse(screen.getByTestId("calls").textContent ?? "[]") as string[];
}

function openPicker(): HTMLElement {
  const input = screen.getByTestId("inspector-agent-model-picker");
  fireEvent.focus(input);
  return input;
}

describe("AgentModelPicker", () => {
  it("shows the default first with status, provenance and result count", () => {
    render(<Harness initialValue="gpt-5" />);
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent("gpt-5");
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent("GPT-5");

    openPicker();
    const listbox = screen.getByTestId("inspector-agent-model-listbox");
    expect(listbox.firstElementChild).toBe(screen.getByTestId("inspector-agent-model-default"));
    expect(screen.getByTestId("inspector-agent-model-status")).toHaveTextContent("Ready");
    expect(screen.getByTestId("inspector-agent-model-count")).toHaveTextContent("3 of 3");
    expect(screen.getByTestId("inspector-agent-model-source")).toHaveTextContent(
      "codex-app-server",
    );
    expect(screen.queryByTestId("inspector-agent-model-stale")).toBeNull();
    expect(calls()).toEqual([]);
  });

  it("keeps the default first while filtering and never commits search typing", () => {
    render(<Harness initialValue="gpt-5" />);
    const input = openPicker();
    fireEvent.change(input, { target: { value: "sonnet" } });

    expect(screen.getByTestId("inspector-agent-model-default")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-agent-model-option-0")).toHaveTextContent(
      "claude-sonnet-4.5",
    );
    expect(screen.queryByTestId("inspector-agent-model-option-1")).toBeNull();
    expect(screen.getByTestId("inspector-agent-model-count")).toHaveTextContent("1 of 3");
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent("gpt-5");
    expect(calls()).toEqual([]);
  });

  it("supports ArrowDown/ArrowUp, Home/End and Enter with the active descendant", () => {
    render(<Harness initialValue="gpt-5" />);
    const input = openPicker();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-option-0").id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls()).toEqual(["select:gpt-5-codex"]);

    const reopened = openPicker();
    fireEvent.keyDown(reopened, { key: "End" });
    expect(reopened).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-option-2").id,
    );
    fireEvent.keyDown(reopened, { key: "Home" });
    expect(reopened).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-default").id,
    );
    fireEvent.keyDown(reopened, { key: "ArrowUp" });
    expect(reopened).toHaveAttribute(
      "aria-activedescendant",
      screen.getByTestId("inspector-agent-model-default").id,
    );
  });

  it("scrolls the active option into view for long lists", async () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<Harness initialValue="gpt-5" />);
      const input = openPicker();
      fireEvent.keyDown(input, { key: "End" });
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll.mock.calls.at(-1)?.[0]).toEqual({ block: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("restores the selected value on Escape and blur without committing", async () => {
    render(<Harness initialValue="gpt-5" />);
    const input = openPicker();
    fireEvent.change(input, { target: { value: "sonnet" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByTestId("inspector-agent-model-listbox")).toBeNull();
    expect(calls()).toEqual([]);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "codex" } });
    fireEvent.blur(input, { relatedTarget: null });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(calls()).toEqual([]);
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent("gpt-5");
  });

  it("persists the exact custom identifier only after explicit confirmation", () => {
    render(<Harness />);
    const custom = screen.getByTestId("inspector-agent-model-custom-input");
    fireEvent.change(custom, { target: { value: "  GPT-XY  " } });
    expect(calls()).toEqual([]);
    fireEvent.click(screen.getByTestId("inspector-agent-model-use-custom"));
    expect(calls()).toEqual(["select:  GPT-XY  "]);
    expect(screen.getByTestId("inspector-agent-model-selected-id").textContent).toBe("  GPT-XY  ");
  });

  it("retains an unknown saved id as unverified across catalog changes", () => {
    const { rerender } = render(<Harness initialValue="legacy-model" catalog={null} />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "Saved model (unverified)",
    );
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent(
      "legacy-model",
    );
    rerender(<Harness initialValue="legacy-model" catalog={CATALOG} />);
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "Saved model (unverified)",
    );
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent(
      "legacy-model",
    );
  });

  it("filters and selects an exact claude-sdk catalog id without resolving or inventing it", () => {
    const sdk: CliModelCatalog = {
      cli: "claude-code",
      projectId: "p1",
      status: "ready",
      scope: "relay-runtime",
      source: "claude-sdk",
      cliVersion: "2.0.0",
      items: [
        {
          id: "claude-sonnet-4-5-20250929",
          label: "Claude Sonnet 4.5",
          provider: "Anthropic",
          description: "SDK-discovered model",
          source: "claude-sdk",
        },
        {
          id: "claude-opus-4-1-20250805",
          label: "Claude Opus 4.1",
          provider: "Anthropic",
          source: "claude-sdk",
        },
      ],
      fetchedAt: 1,
      expiresAt: 2,
      truncated: false,
      customSupported: true,
    };
    render(<Harness catalog={sdk} />);
    const input = openPicker();
    expect(screen.getByTestId("inspector-agent-model-source")).toHaveTextContent(
      "source: claude-sdk",
    );

    fireEvent.change(input, { target: { value: "sonnet" } });
    expect(screen.getByTestId("inspector-agent-model-count")).toHaveTextContent("1 of 2");
    expect(screen.getByTestId("inspector-agent-model-option-0")).toHaveTextContent(
      "claude-sonnet-4-5-20250929",
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(calls()).toEqual(["select:claude-sonnet-4-5-20250929"]);
    expect(screen.getByTestId("inspector-agent-model-selected-id")).toHaveTextContent(
      "claude-sonnet-4-5-20250929",
    );
    expect(screen.getByTestId("inspector-agent-model-selected-label")).toHaveTextContent(
      "Claude Sonnet 4.5",
    );
  });

  it("shows unsupported default/custom fallback and stale state honestly", () => {
    const unsupported: CliModelCatalog = {
      ...CATALOG,
      cli: "claude-code",
      status: "unsupported",
      source: "none",
      items: [],
      message: "Claude Code does not expose a supported model catalog.",
    };
    const { rerender } = render(<Harness catalog={unsupported} />);
    openPicker();
    expect(screen.getByTestId("inspector-agent-model-default")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-agent-model-custom-input")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-agent-model-message")).toHaveTextContent(
      "does not expose a supported model catalog",
    );
    expect(screen.getByTestId("inspector-agent-model-status")).toHaveTextContent(
      "Model listing unavailable",
    );
    expect(screen.queryByTestId("inspector-agent-model-option-0")).toBeNull();

    rerender(<Harness catalog={{ ...CATALOG, status: "stale" }} />);
    expect(screen.getByTestId("inspector-agent-model-stale")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-agent-model-status")).toHaveTextContent("Stale");
  });

  it("refreshes only through the explicit button", () => {
    render(<Harness />);
    const input = openPicker();
    fireEvent.change(input, { target: { value: "gpt" } });
    expect(screen.getByTestId("refreshes")).toHaveTextContent("0");
    fireEvent.click(screen.getByTestId("inspector-agent-model-refresh"));
    expect(screen.getByTestId("refreshes")).toHaveTextContent("1");
  });
});
