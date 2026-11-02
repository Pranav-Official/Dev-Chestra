import { describe, expect, it } from "vitest";
import { validateRunOptions } from "../src/run-options.js";

describe("validateRunOptions", () => {
  it("rejects unenforced budgets, baseSha and unsupported kinds", () => {
    expect(validateRunOptions({ snapshot: {}, budgets: { maxActiveMinutes: 5 } }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, budgets: { maxUsd: 1 } }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, budgets: { maxTokens: 100 } }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, baseSha: "abc" }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, kind: "node_test" }).ok).toBe(false);
    expect(validateRunOptions({ snapshot: {}, kind: "run" }).ok).toBe(true);
  });

  it("reports the offending kind in the error details", () => {
    const result = validateRunOptions({ snapshot: {}, kind: "node_test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_WORKFLOW_INVALID");
    expect(result.error.details).toEqual({ kind: "node_test" });
  });
});
