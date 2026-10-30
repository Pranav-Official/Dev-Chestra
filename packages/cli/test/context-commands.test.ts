import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError, type CliOptions } from "../src/args.js";
import { executeContext } from "../src/context-commands.js";
import { loadProjectContext } from "../src/workflow.js";

describe("context command", () => {
  it("parses list, set and delete", () => {
    expect(parseArgs(["context", "--project", "/tmp/p"]).contextAction).toBe("list");
    expect(parseArgs(["context", "list", "--project", "/tmp/p"]).contextAction).toBe("list");
    const set = parseArgs(["context", "set", "stack", "node20", "--project", "/tmp/p"]);
    expect(set.contextAction).toBe("set");
    expect(set.contextKey).toBe("stack");
    expect(set.contextValue).toBe("node20");
    const del = parseArgs(["context", "delete", "stack", "--project", "/tmp/p"]);
    expect(del.contextAction).toBe("delete");
    expect(del.contextKey).toBe("stack");
    expect(() => parseArgs(["context", "set", "only-key", "--project", "/tmp/p"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["context", "frobnicate", "--project", "/tmp/p"])).toThrow(UsageError);
    expect(() => parseArgs(["context", "list"])).toThrow(UsageError);
  });

  it("round-trips entries through the project file", async () => {
    const project = await mkdtemp(join(tmpdir(), "devchestra-context-cmd-"));
    try {
      const opts = (action: string[]): CliOptions =>
        parseArgs(["context", ...action, "--project", project]) as CliOptions;
      expect(await executeContext(opts([]))).toBe(0);
      expect(await executeContext(opts(["delete", "k"]))).toBe(0);
      expect(await executeContext(opts(["set", "stack", "node20"]))).toBe(0);
      expect(await loadProjectContext(project)).toEqual([{ key: "stack", value: "node20" }]);
      expect(await executeContext(opts(["delete", "stack"]))).toBe(0);
      expect(await loadProjectContext(project)).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
