import { describe, expect, it } from "vitest";
import {
  effectiveSettingsResponseSchema,
  settingsDocumentSchema,
  settingsResponseSchema,
} from "../src/index.js";

describe("settings DTOs", () => {
  it("accepts a document with any subset of the three tiers", () => {
    expect(settingsDocumentSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(
      settingsDocumentSchema.safeParse({
        version: 1,
        models: { high: { cli: "claude-code", model: "opus" }, low: { cli: "pi" } },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["wrong version", { version: 2 }],
    ["unknown tier", { version: 1, models: { ultra: { cli: "pi" } } }],
    ["fake cli", { version: 1, models: { high: { cli: "fake" } } }],
    ["extra key", { version: 1, models: { high: { cli: "pi", effort: "x" } } }],
    ["blank model", { version: 1, models: { high: { cli: "pi", model: "  " } } }],
    ["control character in model", { version: 1, models: { high: { cli: "pi", model: "a\nb" } } }],
    ["unknown top-level key", { version: 1, variables: {} }],
  ])("rejects %s", (_name, value) => {
    expect(settingsDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("describes one settings file", () => {
    const etag = "a".repeat(64);
    expect(
      settingsResponseSchema.safeParse({
        scope: "local",
        document: { version: 1 },
        etag,
        exists: false,
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      settingsResponseSchema.safeParse({
        scope: "team",
        document: { version: 1 },
        etag,
        exists: false,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("returns exactly one effective entry per tier", () => {
    const entry = (tier: string) => ({ tier, mapping: null });
    expect(
      effectiveSettingsResponseSchema.safeParse({
        tiers: [entry("high"), entry("medium"), entry("low")],
      }).success,
    ).toBe(true);
    expect(effectiveSettingsResponseSchema.safeParse({ tiers: [entry("high")] }).success).toBe(
      false,
    );
  });
});
