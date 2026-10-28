import { describe, expect, it } from "vitest";
import { isFakeScriptEnabled, parseArgs, UsageError } from "../src/args.js";
import { defaultDataDir } from "../src/data-dir.js";

describe("CLI args", () => {
  it("parses run, params and flags", () => {
    const options = parseArgs([
      "run",
      "workflow.json",
      "--project",
      "/tmp/project",
      "--data-dir",
      "/tmp/data",
      "--param",
      "count=3",
      "--param",
      "name=alpha",
      "--json",
      "--embedded",
      "--budget-usd",
      "2",
    ]);
    expect(options.command).toBe("run");
    expect(options.workflow).toBe("workflow.json");
    expect(options.project).toBe("/tmp/project");
    expect(options.params).toEqual({ count: 3, name: "alpha" });
    expect(options.json).toBe(true);
    expect(options.embedded).toBe(true);
    expect(options.budgetUsd).toBe(2);
  });

  it("requires a project for run but defaults the data dir", () => {
    expect(() => parseArgs(["run", "w.json", "--data-dir", "/tmp/d"])).toThrow(UsageError);
    expect(parseArgs(["run", "w.json", "--project", "/tmp/p"]).dataDir).toBe(defaultDataDir());
    expect(parseArgs(["resume", "r1"]).dataDir).toBe(defaultDataDir());
    expect(parseArgs(["doctor", "--data-dir", "/tmp/d"]).dataDir).toBe("/tmp/d");
  });

  it("accepts the deprecated --allow-experimental-adapters flag and records it", () => {
    const options = parseArgs(["start", "--allow-experimental-adapters"]);
    expect(options.deprecatedFlags).toEqual(["--allow-experimental-adapters"]);
  });

  it("restricts uncertain retry to resume and fake script to run", () => {
    expect(() =>
      parseArgs([
        "run",
        "w.json",
        "--project",
        "/tmp/p",
        "--data-dir",
        "/tmp/d",
        "--retry-uncertain-shell",
      ]),
    ).toThrow(UsageError);
    expect(
      parseArgs(["resume", "r1", "--data-dir", "/tmp/d", "--fake-script", "s.json"]).fakeScript,
    ).toBe("s.json");
    expect(
      parseArgs(["resume", "r1", "--data-dir", "/tmp/d", "--retry-uncertain-shell"])
        .retryUncertainShell,
    ).toBe(true);
  });

  it("restricts the decision probe to doctor", () => {
    expect(parseArgs(["doctor", "--data-dir", "/tmp/d", "--probe-decisions"]).probeDecisions).toBe(
      true,
    );
    expect(parseArgs(["doctor", "--data-dir", "/tmp/d"]).probeDecisions).toBe(false);
    expect(() =>
      parseArgs([
        "run",
        "w.json",
        "--project",
        "/tmp/p",
        "--data-dir",
        "/tmp/d",
        "--probe-decisions",
      ]),
    ).toThrow(UsageError);
  });

  it("parses start flags and blocks run-only flags", () => {
    const options = parseArgs([
      "start",
      "--data-dir",
      "/tmp/data",
      "--port",
      "0",
      "--no-open",
      "--print-url",
      "--fake-script",
      "s.json",
    ]);
    expect(options.command).toBe("start");
    expect(options.port).toBe(0);
    expect(options.noOpen).toBe(true);
    expect(options.printUrl).toBe(true);
    expect(options.fakeScript).toBe("s.json");
    expect(() => parseArgs(["start", "--data-dir", "/tmp/data", "--param", "x=1"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["start", "--data-dir", "/tmp/data", "--project", "/tmp/p"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["start", "--data-dir", "/tmp/data", "--port", "70000"])).toThrow(
      UsageError,
    );
    expect(() =>
      parseArgs(["run", "w.json", "--project", "/tmp/p", "--data-dir", "/tmp/d", "--port", "1"]),
    ).toThrow(UsageError);
  });

  it("parses run workspace flags and rejects inconsistent combinations", () => {
    const base = ["run", "w.json", "--project", "/tmp/p", "--data-dir", "/tmp/d"];
    expect(parseArgs(base).workspaceMode).toBeUndefined();
    expect(parseArgs([...base, "--workspace", "project"]).workspaceMode).toBe("project");
    expect(parseArgs([...base, "--workspace", "new-worktree"]).workspaceMode).toBe("new-worktree");
    const existing = parseArgs([
      ...base,
      "--workspace",
      "existing-worktree",
      "--worktree-path",
      "/tmp/wt",
    ]);
    expect(existing.workspaceMode).toBe("existing-worktree");
    expect(existing.worktreePath).toBe("/tmp/wt");

    expect(() => parseArgs([...base, "--workspace", "scratch"])).toThrow(UsageError);
    expect(() => parseArgs([...base, "--workspace", "existing-worktree"])).toThrow(UsageError);
    expect(() => parseArgs([...base, "--worktree-path", "/tmp/wt"])).toThrow(UsageError);
    expect(() =>
      parseArgs([...base, "--workspace", "project", "--worktree-path", "/tmp/wt"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["resume", "r1", "--data-dir", "/tmp/d", "--workspace", "project"]),
    ).toThrow(UsageError);
  });

  it("rejects unknown options", () => {
    expect(() =>
      parseArgs(["run", "w.json", "--project", "/tmp/p", "--data-dir", "/tmp/d", "--bogus"]),
    ).toThrow(UsageError);
  });
});

describe("fake script gate", () => {
  it("follows the single DEVCHESTRA_ALLOW_FAKE gate owned by @devchestra/schema", () => {
    expect(isFakeScriptEnabled({ DEVCHESTRA_ALLOW_FAKE: "1" })).toBe(true);
    expect(isFakeScriptEnabled({ DEVCHESTRA_ALLOW_FAKE: "true" })).toBe(true);
    expect(isFakeScriptEnabled({ DEVCHESTRA_ALLOW_FAKE: "0" })).toBe(false);
    expect(isFakeScriptEnabled({})).toBe(false);
  });
});
