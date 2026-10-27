import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

import { createAdapter, createAdapterRegistry, describeInvocation } from "../src/index.js";
import { fixtureJson, request, TOKEN } from "./helpers.js";

describe("claude-code plan", () => {
  it("matches the synthetic fresh golden argv and keeps the token out of argv", () => {
    const adapter = createAdapter("claude-code");
    const result = adapter.plan(
      request({
        model: "claude-sonnet",
        permissions: { network: false, write: [], extraReadDirs: ["/extra"] },
        cliOptions: { appendSystemPrompt: "be brief", maxBudgetUsd: 0.5 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = fixtureJson("golden", "claude-fresh.json");
    expect(result.value.bin).toBe(golden.bin);
    expect(result.value.args).toEqual(golden.args);
    expect(JSON.stringify(result.value.args)).not.toContain(TOKEN);
    expect(JSON.stringify(describeInvocation(result.value))).not.toContain(TOKEN);
    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.path).toBe("/run/mcp.json");
    expect(result.value.files[0]?.mode).toBe(0o600);
    const config = JSON.parse(result.value.files[0]?.content ?? "{}") as {
      mcpServers: { relay: { env: Record<string, string> } };
    };
    expect(config.mcpServers.relay.env.RELAY_EXEC_TOKEN).toBe(TOKEN);
  });

  it("matches resume and re-passes MCP and permissions", () => {
    const adapter = createAdapter("claude-code");
    const result = adapter.plan(
      request({
        mode: "resume",
        sessionId: "11111111-1111-4111-8111-111111111111",
        permissions: { network: true, write: ["workspace"], extraReadDirs: [] },
        limits: { timeoutMs: 5_000, maxTurns: 4 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = fixtureJson("golden", "claude-resume.json");
    expect(result.value.args).toEqual(golden.args);
    expect(result.value.args).toContain("--resume");
    expect(result.value.args).not.toContain("--sandbox");
  });

  it("rejects unknown and safety options", () => {
    const adapter = createAdapter("claude-code");
    for (const cliOptions of [
      { sandbox: "read-only" },
      { permissionMode: "bypassPermissions" },
      { mcp: {} },
      { disallowedTools: "Bash" },
      { allowedTools: ["Bash"] },
    ]) {
      expect(adapter.plan(request({ cliOptions })).ok).toBe(false);
    }
    expect(adapter.plan(request({ mode: "resume", sessionId: "not-a-uuid" })).ok).toBe(false);
  });

  it("never emits bypass/danger flags", () => {
    const adapter = createAdapter("claude-code");
    const planned = adapter.plan(
      request({ permissions: { network: true, write: ["workspace"], extraReadDirs: [] } }),
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.args.join(" ")).not.toContain("bypass");
  });
});

describe("codex plan", () => {
  it("matches fresh argv, uses env_vars names and no token in argv", () => {
    const adapter = createAdapter("codex");
    const result = adapter.plan(
      request({
        model: "gpt-5",
        permissions: { network: true, write: ["workspace"], extraReadDirs: [] },
        cliOptions: { configOverrides: { model_reasoning_effort: "low" } },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = fixtureJson("golden", "codex-fresh.json");
    expect(result.value.args).toEqual(golden.args);
    expect(JSON.stringify(result.value.args)).not.toContain(TOKEN);
    expect(result.value.env.RELAY_EXEC_TOKEN).toBe(TOKEN);
    expect(result.value.env.RELAY_GATEWAY_URL).toBe("http://127.0.0.1:4310");
  });

  it("resume avoids fresh-only flags and supplies sandbox via config", () => {
    const adapter = createAdapter("codex");
    const result = adapter.plan(request({ mode: "resume", sessionId: "thread-1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = fixtureJson("golden", "codex-resume.json");
    expect(result.value.args).toEqual(golden.args);
    for (const forbidden of ["--sandbox", "--cd", "--add-dir", "-a", "-p", "--ask-for-approval"]) {
      expect(result.value.args).not.toContain(forbidden);
    }
    expect(result.value.cwd).toBe("/work");
  });

  it("rejects unknown config overrides and addDirs on resume", () => {
    const adapter = createAdapter("codex");
    for (const cliOptions of [
      { sandbox: "danger-full-access" },
      { configOverrides: { sandbox_mode: "danger-full-access" } },
      { configOverrides: { mcp_servers: "x" } },
      { configOverrides: { model_reasoning_effort: 2 as never } },
    ]) {
      expect(adapter.plan(request({ cliOptions })).ok).toBe(false);
    }
    expect(
      adapter.plan(
        request({ mode: "resume", sessionId: "thread-1", cliOptions: { addDirs: ["/x"] } }),
      ).ok,
    ).toBe(false);
  });

  it("never emits dangerous sandbox values", () => {
    const adapter = createAdapter("codex");
    const result = adapter.plan(
      request({ permissions: { network: false, write: ["project"], extraReadDirs: [] } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const joined = result.value.args.join(" ");
    expect(joined).not.toContain("danger-full-access");
    expect(joined).not.toContain("dangerously-bypass");
    expect(joined).toContain("workspace-write");
  });
});

describe("fake plan", () => {
  const options = { fakeAgentBin: "/fake/main.js", nodeBin: "/usr/bin/node" };

  it("matches fresh/resume golden argv and requires checkpoint on resume", () => {
    const adapter = createAdapter("fake", options);
    const fresh = adapter.plan(
      request({
        cliOptions: { checkpoint: ".relay/fake-checkpoint.json", session: "fake-session" },
      }),
    );
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.args).toEqual(fixtureJson("golden", "fake-fresh.json").args);
    expect(fresh.value.args[0]).toBe("/fake/main.js");
    const resume = adapter.plan(
      request({ mode: "resume", cliOptions: { checkpoint: ".relay/fake-checkpoint.json" } }),
    );
    expect(resume.ok).toBe(true);
    if (!resume.ok) return;
    expect(resume.value.args).toEqual(fixtureJson("golden", "fake-resume.json").args);
    const defaulted = adapter.plan(request({ mode: "resume" }));
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.value.args).toContain("/work/.relay/fake-checkpoint.json");
    }
  });

  it("isolates fake-only knobs and rejects path traversal", () => {
    const adapter = createAdapter("fake", options);
    expect(adapter.plan(request({ cliOptions: { checkpoint: "../escape.json" } })).ok).toBe(false);
    expect(adapter.plan(request({ cliOptions: { script: [{ type: "submit" }] } })).ok).toBe(false);
    expect(adapter.plan(request({ cliOptions: { bin: "/bin/sh" } })).ok).toBe(false);
  });

  it("allows a checkpoint under the engine-owned exec dir but not arbitrary roots", () => {
    const base = mkdtempSync(join(tmpdir(), "relay-fake-checkpoint-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const cwd = join(base, "project");
    const execDir = join(base, "exec", "node", "attempt-1");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(execDir, { recursive: true });
    const adapter = createAdapter("fake", options);

    const insideExec = adapter.plan(
      request({
        cwd,
        execDir,
        cliOptions: { checkpoint: join(execDir, "fake-checkpoint.json") },
      }),
    );
    expect(insideExec.ok).toBe(true);
    if (insideExec.ok) {
      expect(insideExec.value.args).toContain(join(execDir, "fake-checkpoint.json"));
    }

    const insideCwd = adapter.plan(
      request({ cwd, execDir, cliOptions: { checkpoint: join(cwd, ".relay/fake.json") } }),
    );
    expect(insideCwd.ok).toBe(true);

    const outside = adapter.plan(
      request({ cwd, execDir, cliOptions: { checkpoint: join(base, "outside.json") } }),
    );
    expect(outside.ok).toBe(false);
  });

  it("rejects a checkpoint symlink that escapes the allowed roots", () => {
    const base = mkdtempSync(join(tmpdir(), "relay-fake-checkpoint-link-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const cwd = join(base, "project");
    const execDir = join(base, "exec");
    const outside = join(base, "outside");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(execDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(execDir, "fake-checkpoint.json");
    symlinkSync(join(outside, "target.json"), link);
    const adapter = createAdapter("fake", options);
    expect(adapter.plan(request({ cwd, execDir, cliOptions: { checkpoint: link } })).ok).toBe(
      false,
    );
  });

  it("injects a trusted default script only when env has none", () => {
    const adapter = createAdapter("fake", {
      ...options,
      fakeScript: [{ type: "submit", output: { answer: "ok" } }],
    });
    const first = adapter.plan(request());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.env.FAKE_AGENT_SCRIPT).toContain("submit");
    const explicit = adapter.plan(request({ env: { FAKE_AGENT_SCRIPT: "[]" } }));
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.env.FAKE_AGENT_SCRIPT).toBe("[]");
  });

  it("defaults to the absolute built fake agent bin", () => {
    const adapter = createAdapter("fake");
    const result = adapter.plan(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.args[0]).toMatch(/tools\/fake-agent\/dist\/main\.js$/);
    expect(result.value.bin).toBe(process.execPath);
  });
});

describe("registry", () => {
  it("exposes only explicitly enabled ids", () => {
    const registry = createAdapterRegistry({ ids: ["fake"], fakeAgentBin: "/fake/main.js" });
    expect(registry.has("fake")).toBe(true);
    expect(registry.has("codex")).toBe(false);
    expect(() => registry.get("codex")).toThrow();
    expect(registry.get("fake").id).toBe("fake");
    expect(registry.ids()).toEqual(["fake"]);
  });
});
