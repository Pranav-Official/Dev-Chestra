import { describe, expect, it } from "vitest";
import type { CliModelItem } from "../src/editor/inspector/model/catalog.js";
import { normalizeModelText, rankModels } from "../src/editor/inspector/model/rank.js";

const items: CliModelItem[] = [
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
];

describe("rankModels", () => {
  it("normalizes punctuation and case for matching only", () => {
    expect(normalizeModelText("GPT-5_Codex")).toBe("gpt 5 codex");
    expect(rankModels(items, "GPT 5 CODEX")[0]?.id).toBe("gpt-5-codex");
    expect(rankModels(items, "gpt.5")[0]?.id).toBe("gpt-5");
  });

  it("puts an exact identifier ahead of normalized and label matches", () => {
    const ranked = rankModels(items, "gpt-5");
    expect(ranked.map((item) => item.id)).toEqual(["gpt-5", "gpt-5-codex"]);
  });

  it("matches prefixes, tokens, providers and aliases deterministically", () => {
    expect(rankModels(items, "codex")[0]?.id).toBe("gpt-5-codex");
    expect(rankModels(items, "openai").map((item) => item.id)).toEqual(["gpt-5-codex", "gpt-5"]);
    expect(rankModels(items, "anthropic")[0]?.id).toBe("claude-sonnet-4.5");
    expect(rankModels(items, "gpt5c")[0]?.id).toBe("gpt-5-codex");
  });

  it("falls back to a case-insensitive subsequence", () => {
    expect(rankModels(items, "snt")[0]?.id).toBe("claude-sonnet-4.5");
    expect(rankModels(items, "zzzz")).toEqual([]);
  });

  it("keeps equal scores in catalog order", () => {
    const tied = [
      { id: "alpha", label: "Alpha" },
      { id: "alpine", label: "Alpine" },
    ];
    expect(rankModels(tied, "al").map((item) => item.id)).toEqual(["alpha", "alpine"]);
    expect(rankModels([...tied].reverse(), "al").map((item) => item.id)).toEqual([
      "alpine",
      "alpha",
    ]);
  });

  it("returns the catalog order unchanged for an empty or punctuation-only query", () => {
    expect(rankModels(items, "").map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(rankModels(items, "---").map((item) => item.id)).toEqual(items.map((item) => item.id));
  });
});
