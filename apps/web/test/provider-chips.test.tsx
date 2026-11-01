import type { AgentNode } from "@devchestra/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { AgentForm } from "../src/editor/inspector/AgentForm.js";
import type { AvailableCli } from "../src/editor/inspector/model/useAvailableClis.js";
import { ProviderChips } from "../src/editor/inspector/ProviderChips.js";

const CLIS: AvailableCli[] = [
  { id: "claude-code", label: "Claude Code", help: "", enabled: true },
  { id: "codex", label: "Codex", help: "", enabled: false },
  { id: "opencode", label: "OpenCode", help: "", enabled: true },
  { id: "pi", label: "Pi", help: "", enabled: true },
];

function Harness({
  initial,
  clis = CLIS,
}: {
  initial: "claude-code" | "codex" | "opencode" | "pi";
  clis?: AvailableCli[];
}) {
  const [value, setValue] = useState(initial);
  return <ProviderChips clis={clis} value={value} onSelect={(next) => setValue(next)} />;
}

function chip(id: string): HTMLElement {
  return screen.getByTestId(`inspector-agent-cli-${id}`);
}

describe("ProviderChips", () => {
  it("lists enabled providers only", () => {
    render(<Harness initial="claude-code" />);
    expect(screen.getByRole("radiogroup", { name: "Provider" })).toBe(
      screen.getByTestId("inspector-agent-cli"),
    );
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Claude Code",
      "OpenCode",
      "Pi",
    ]);
    expect(screen.queryByTestId("inspector-agent-cli-codex")).toBeNull();
  });

  it("keeps a turned-off selected provider visible with an Off tag", () => {
    render(<Harness initial="codex" />);
    expect(chip("codex")).toHaveAttribute("aria-checked", "true");
    expect(chip("codex")).toHaveTextContent("Off");
    expect(chip("codex").getAttribute("data-off")).toBe("true");
    expect(chip("claude-code")).toHaveAttribute("aria-checked", "false");
  });

  it("drops the turned-off provider once another one is picked", () => {
    render(<Harness initial="codex" />);
    fireEvent.click(chip("pi"));
    expect(chip("pi")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("inspector-agent-cli-codex")).toBeNull();
  });

  it("uses roving tabIndex with the selected chip in the tab order", () => {
    render(<Harness initial="opencode" />);
    expect(chip("opencode")).toHaveAttribute("tabindex", "0");
    expect(chip("claude-code")).toHaveAttribute("tabindex", "-1");
    expect(chip("pi")).toHaveAttribute("tabindex", "-1");
  });

  it("moves and selects the next enabled chip with ArrowRight and ArrowDown", () => {
    const onSelect = vi.fn();
    render(<ProviderChips clis={CLIS} value="claude-code" onSelect={onSelect} />);
    fireEvent.keyDown(chip("claude-code"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("opencode");
    fireEvent.keyDown(chip("claude-code"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("opencode");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("skips turned-off providers when moving backwards and wraps around", () => {
    const onSelect = vi.fn();
    render(<ProviderChips clis={CLIS} value="claude-code" onSelect={onSelect} />);
    fireEvent.keyDown(chip("claude-code"), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("pi");
    fireEvent.keyDown(chip("claude-code"), { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("pi");
  });

  it("moves away from a turned-off selected provider to the nearest enabled ones", () => {
    const onSelect = vi.fn();
    render(<ProviderChips clis={CLIS} value="codex" onSelect={onSelect} />);
    fireEvent.keyDown(chip("codex"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("opencode");
    fireEvent.keyDown(chip("codex"), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("claude-code");
  });

  it("jumps to the first and last enabled chip with Home and End", () => {
    const onSelect = vi.fn();
    render(<ProviderChips clis={CLIS} value="opencode" onSelect={onSelect} />);
    fireEvent.keyDown(chip("opencode"), { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("claude-code");
    fireEvent.keyDown(chip("opencode"), { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("pi");
  });

  it("selects on click and does nothing when the selected chip is clicked again", () => {
    const onSelect = vi.fn();
    render(<ProviderChips clis={CLIS} value="claude-code" onSelect={onSelect} />);
    fireEvent.click(chip("claude-code"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(chip("pi"));
    expect(onSelect).toHaveBeenCalledWith("pi");
  });

  it("renders a monochrome icon on every chip", () => {
    const { container } = render(<Harness initial="codex" />);
    const chips = container.querySelectorAll('[role="radio"]');
    expect(chips.length).toBe(4);
    for (const element of chips) {
      expect(element.querySelector("svg")).not.toBeNull();
    }
  });
});

describe("AgentForm provider switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains the block and links to Settings when the node's provider is turned off", async () => {
    vi.spyOn(api, "listClis").mockResolvedValue({
      clis: [
        { id: "claude-code", label: "Claude Code", experimental: false, enabled: true },
        { id: "codex", label: "Codex", experimental: false, enabled: false },
      ],
    });
    const node: AgentNode = {
      id: "node-agent",
      type: "agent",
      name: "Research",
      cli: "codex",
      prompt: "Find the facts.",
      output: { type: "object", properties: {}, additionalProperties: false },
      permissions: { network: false, write: ["workspace"] },
      workspace: { mode: "scratch" },
      limits: { timeoutMin: 30, validationRetries: 2, crashRetries: 1 },
    };
    render(<AgentForm node={node} issues={[]} onPatch={vi.fn()} projectId="p1" />);

    const notice = await screen.findByTestId("inspector-agent-cli-off");
    expect(notice).toHaveTextContent(
      "Codex is turned off. Runs that use this node are blocked. Turn it on in Settings, or pick another provider.",
    );
    const link = notice.querySelector("a");
    expect(link).toHaveAttribute("href", "/p/p1/settings/providers");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByTestId("inspector-agent-cli-codex")).toHaveAttribute("aria-checked", "true");
  });
});
