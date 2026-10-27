import { describe, expect, it } from "vitest";
import {
  defaultRunWorkspaceSelection,
  isRunWorkspaceBinding,
  isRunWorkspaceSelection,
} from "../src/workspace.js";

describe("run workspace selections", () => {
  it("accepts the three browser-safe selections", () => {
    expect(isRunWorkspaceSelection({ mode: "project" })).toBe(true);
    expect(isRunWorkspaceSelection({ mode: "new-worktree" })).toBe(true);
    expect(isRunWorkspaceSelection({ mode: "existing-worktree", path: "/repo/wt" })).toBe(true);
    expect(defaultRunWorkspaceSelection()).toEqual({ mode: "project" });
  });

  it("rejects malformed or non-absolute-ish selections", () => {
    expect(isRunWorkspaceSelection(null)).toBe(false);
    expect(isRunWorkspaceSelection({ mode: "scratch" })).toBe(false);
    expect(isRunWorkspaceSelection({ mode: "existing-worktree" })).toBe(false);
    expect(isRunWorkspaceSelection({ mode: "existing-worktree", path: "" })).toBe(false);
    expect(isRunWorkspaceSelection({ mode: "existing-worktree", path: "/a\0b" })).toBe(false);
  });

  it("requires a project root on a frozen binding", () => {
    expect(isRunWorkspaceBinding({ selection: { mode: "project" }, projectRoot: "/repo" })).toBe(
      true,
    );
    expect(isRunWorkspaceBinding({ selection: { mode: "project" } })).toBe(false);
    expect(isRunWorkspaceBinding({ selection: { mode: "project" }, projectRoot: "" })).toBe(false);
  });
});
