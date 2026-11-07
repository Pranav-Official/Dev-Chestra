import type { EffectiveSettingsResponse } from "@devchestra/api";
import type { AgentNode } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { AgentForm } from "../src/editor/inspector/AgentForm.js";

const BASE: Omit<AgentNode, "cli" | "tier"> = {
  id: "node-agent",
  type: "agent",
  name: "Research",
  prompt: "Find the facts.",
  output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  permissions: { network: false, write: ["workspace"] },
  workspace: { mode: "scratch" },
};

const EFFECTIVE: EffectiveSettingsResponse = {
  tiers: [
    { tier: "high", mapping: { ref: { cli: "claude-code", model: "opus" }, source: "local" } },
    { tier: "medium", mapping: { ref: { cli: "codex" }, source: "project" } },
    { tier: "low", mapping: null },
  ],
};

beforeEach(() => {
  vi.spyOn(api, "listClis").mockResolvedValue({
    clis: [
      { id: "claude-code", label: "Claude Code", experimental: false, enabled: true },
      { id: "codex", label: "Codex", experimental: false, enabled: true },
      { id: "opencode", label: "Opencode", experimental: false, enabled: true },
      { id: "pi", label: "Pi", experimental: false, enabled: true },
    ],
  });
  vi.spyOn(api, "getEffectiveSettings").mockResolvedValue(EFFECTIVE);
  vi.spyOn(api, "getCliMcpServers").mockResolvedValue({
    cli: "claude-code",
    projectId: "p1",
    servers: [],
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderForm(node: AgentNode, onPatch = vi.fn(), probeMode = false) {
  render(
    <AgentForm node={node} issues={[]} onPatch={onPatch} projectId="p1" probeMode={probeMode} />,
  );
  return onPatch;
}

describe("AgentForm model source", () => {
  it("offers a model tier next to a specific model and starts on the node's own choice", () => {
    renderForm({ ...BASE, cli: "codex" });
    expect(screen.getByTestId("inspector-agent-source-specific")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("inspector-agent-source-tier")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("inspector-agent-cli")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-agent-tier")).toBeNull();
  });

  it("switches to a tier and drops the fixed provider and model", () => {
    const onPatch = renderForm({ ...BASE, cli: "codex", model: "gpt-5" });
    fireEvent.click(screen.getByTestId("inspector-agent-source-tier"));
    expect(onPatch).toHaveBeenCalledWith({ tier: "medium", cli: undefined, model: undefined });
  });

  it("shows the tier chips and what the picked tier resolves to on this machine", async () => {
    renderForm({ ...BASE, tier: "high" });
    expect(screen.getByTestId("inspector-agent-tier-high")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("inspector-agent-cli")).toBeNull();
    const resolved = await screen.findByTestId("inspector-tier-resolved");
    expect(resolved).toHaveTextContent("Claude Code · opus");
    expect(resolved).toHaveTextContent("This machine");
  });

  it("says where a mapping came from and names the provider default model", async () => {
    renderForm({ ...BASE, tier: "medium" });
    const resolved = await screen.findByTestId("inspector-tier-resolved");
    expect(resolved).toHaveTextContent("Codex · provider default model");
    expect(resolved).toHaveTextContent("Project settings");
  });

  it("warns when the picked tier is not set here and links to Project settings", async () => {
    renderForm({ ...BASE, tier: "low" });
    const warning = await screen.findByTestId("inspector-tier-unset");
    expect(warning).toHaveTextContent("Low isn't set on this machine.");
    expect(warning.querySelector("a")).toHaveAttribute("href", "/p/p1/settings/models");
    expect(screen.getByTestId("inspector-agent-tier-low")).toHaveTextContent("Not set");
    expect(screen.getByTestId("inspector-agent-tier-high")).not.toHaveTextContent("Not set");
  });

  it("changes the tier", async () => {
    const onPatch = renderForm({ ...BASE, tier: "high" });
    await screen.findByTestId("inspector-tier-resolved");
    fireEvent.click(screen.getByTestId("inspector-agent-tier-low"));
    expect(onPatch).toHaveBeenCalledWith({ tier: "low" });
  });

  it("moves between tiers with the arrow keys", async () => {
    const onPatch = renderForm({ ...BASE, tier: "high" });
    await screen.findByTestId("inspector-tier-resolved");
    fireEvent.keyDown(screen.getByTestId("inspector-agent-tier-high"), { key: "ArrowRight" });
    expect(onPatch).toHaveBeenCalledWith({ tier: "medium" });
  });

  it("returns to a specific model seeded from what the tier resolved to", async () => {
    const onPatch = renderForm({ ...BASE, tier: "high" });
    await screen.findByTestId("inspector-tier-resolved");
    fireEvent.click(screen.getByTestId("inspector-agent-source-specific"));
    expect(onPatch).toHaveBeenCalledWith({ tier: undefined, cli: "claude-code", model: "opus" });
  });

  it("falls back to the first enabled provider when the tier is not set here", async () => {
    const onPatch = renderForm({ ...BASE, tier: "low" });
    await screen.findByTestId("inspector-tier-unset");
    fireEvent.click(screen.getByTestId("inspector-agent-source-specific"));
    expect(onPatch).toHaveBeenCalledWith({ tier: undefined, cli: "claude-code", model: undefined });
  });

  it("does not claim a tier is unset when the settings cannot be read", async () => {
    vi.spyOn(api, "getEffectiveSettings").mockRejectedValue(new Error("offline"));
    renderForm({ ...BASE, tier: "high" });
    expect(await screen.findByTestId("inspector-tier-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-tier-unset")).toBeNull();
  });

  it("lists MCP servers for the provider the tier maps to here", async () => {
    renderForm({ ...BASE, tier: "high" });
    await screen.findByTestId("inspector-tier-resolved");
    expect(await screen.findByTestId("inspector-tools-tier-note")).toHaveTextContent(
      "Listing servers for Claude Code",
    );
    await waitFor(() => expect(api.getCliMcpServers).toHaveBeenCalled());
  });

  it("asks for a mapped tier before listing MCP servers", async () => {
    renderForm({ ...BASE, tier: "low" });
    await screen.findByTestId("inspector-tier-unset");
    expect(screen.getByTestId("inspector-tools-notier")).toHaveTextContent(
      "Servers are listed once this tier is set on this machine.",
    );
    expect(api.getCliMcpServers).not.toHaveBeenCalled();
  });

  it("works the same for a polling probe", () => {
    const onPatch = renderForm({ ...BASE, id: "probe", cli: "codex" }, vi.fn(), true);
    fireEvent.click(screen.getByTestId("inspector-agent-source-tier"));
    expect(onPatch).toHaveBeenCalledWith({ tier: "medium", cli: undefined, model: undefined });
  });
});
