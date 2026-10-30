import { describe, expect, it } from "vitest";
import { parseContextEntries } from "../src/context.js";
import { normalizeWorkflow } from "../src/normalize.js";
import { parseWorkflow } from "../src/parse.js";
import { validateWorkflow } from "../src/validate.js";
import { chainRaw } from "./helpers.js";

describe("context pools", () => {
  it("parses project context entries and rejects bad ones", () => {
    expect(parseContextEntries([{ key: "stack", value: "node20" }]).ok).toBe(true);
    expect(parseContextEntries("nope").ok).toBe(false);
    expect(parseContextEntries([{ key: "-bad", value: "v" }]).ok).toBe(false);
    expect(
      parseContextEntries([
        { key: "a", value: "1" },
        { key: "a", value: "2" },
      ]).ok,
    ).toBe(false);
    expect(parseContextEntries([{ key: "big", value: "x".repeat(5000) }]).ok).toBe(false);
  });

  it("accepts workflow context entries and freezes them into the normalized snapshot", () => {
    const raw = chainRaw() as Record<string, unknown>;
    raw.context = [{ key: "goal", value: "ship it" }];
    const parsed = parseWorkflow(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateWorkflow(parsed.value).ok).toBe(true);
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.context).toEqual([{ key: "goal", value: "ship it" }]);
  });

  it("rejects duplicate workflow context keys", () => {
    const raw = chainRaw() as Record<string, unknown>;
    raw.context = [
      { key: "goal", value: "one" },
      { key: "goal", value: "two" },
    ];
    const parsed = parseWorkflow(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain("E_WORKFLOW_INVALID");
  });
});
