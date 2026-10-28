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

  it("emits no MCP selection flags when the engine selected nothing", () => {
    const adapter = createAdapter("codex");
    const result = adapter.plan(request({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const joined = result.value.args.join("\n");
    expect(joined).not.toContain("mcp_servers.fixture");
    expect(joined).not.toContain("features.apps");
    expect(joined).not.toContain("features.shell_tool");
    expect(joined).not.toContain("apps.default");
  });
});

describe("codex mcp selection", () => {
  const SECRET = "extra-secret-value-xyz";

  function planned(overrides: Parameters<typeof request>[0]) {
    const adapter = createAdapter("codex");
    const result = adapter.plan(request(overrides));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("plan failed unexpectedly");
    return result.value;
  }

  it("attaches a stdio extra via -c overrides with secrets only in env", () => {
    const inv = planned({
      extraMcp: [
        {
          name: "fixture",
          scope: "global",
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["echo-server.mjs"],
          env: { FIXTURE_MCP_NAME: "fixture", FIXTURE_MCP_LOG: "/tmp/fixture.log" },
        },
      ],
    });
    const joined = inv.args.join("\n");
    expect(joined).toContain('-c\nmcp_servers.fixture.command="/usr/bin/node"');
    expect(joined).toContain('mcp_servers.fixture.args=["echo-server.mjs"]');
    expect(joined).toContain('mcp_servers.fixture.env_vars=["FIXTURE_MCP_NAME","FIXTURE_MCP_LOG"]');
    expect(joined).toContain("mcp_servers.fixture.enabled=true");
    expect(inv.env.FIXTURE_MCP_NAME).toBe("fixture");
    expect(inv.env.FIXTURE_MCP_LOG).toBe("/tmp/fixture.log");
    // Env values travel in the child env, never in argv.
    expect(JSON.stringify(inv.args)).not.toContain("/tmp/fixture.log");
    expect(JSON.stringify(inv.args)).not.toContain(TOKEN);
  });

  it("attaches http and sse extras via url + env_http_headers", () => {
    const inv = planned({
      extraMcp: [
        {
          name: "remote",
          scope: "project",
          transport: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: `Bearer ${SECRET}`, "X-Api-Key": SECRET },
        },
        {
          name: "stream",
          scope: "global",
          transport: "sse",
          url: "https://sse.example.com/events",
        },
      ],
    });
    const joined = inv.args.join("\n");
    expect(joined).toContain('mcp_servers.remote.url="https://mcp.example.com/mcp"');
    expect(joined).toContain("mcp_servers.remote.env_http_headers=");
    expect(joined).toContain("mcp_servers.remote.enabled=true");
    expect(joined).toContain('mcp_servers.stream.url="https://sse.example.com/events"');
    expect(joined).not.toContain("mcp_servers.stream.env_http_headers");
    // Secret values travel only in the child env, keyed by synthesised names.
    expect(JSON.stringify(inv.args)).not.toContain(SECRET);
    expect(inv.env.RELAY_MCP_REMOTE_AUTHORIZATION).toBe(`Bearer ${SECRET}`);
    expect(inv.env.RELAY_MCP_REMOTE_X_API_KEY).toBe(SECRET);
  });

  it("switches off known-but-unselected servers and never relay", () => {
    const inv = planned({
      extraMcp: [
        {
          name: "fixture",
          scope: "global",
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["x.mjs"],
        },
      ],
      knownMcp: [
        { name: "fixture", scope: "global" },
        { name: "other", scope: "global" },
        { name: "docs", scope: "project" },
        { name: "relay", scope: "global" },
      ],
    });
    const joined = inv.args.join("\n");
    expect(joined).toContain("mcp_servers.other.enabled=false");
    expect(joined).toContain("mcp_servers.docs.enabled=false");
    expect(joined).not.toContain("mcp_servers.fixture.enabled=false");
    expect(joined).not.toContain("mcp_servers.relay.enabled=false");
  });

  it("disables the apps server when no connector is selected", () => {
    const inv = planned({
      knownMcp: [
        { name: "other", scope: "global" },
        { name: "gmail", scope: "connector", connectorId: "connector_gmail" },
      ],
    });
    const joined = inv.args.join("\n");
    expect(joined).toContain("features.apps=false");
    expect(joined).toContain("mcp_servers.other.enabled=false");
    expect(joined).not.toContain("apps.default");
  });

  it("selects connectors per id and leaves the rest off", () => {
    const inv = planned({
      extraMcp: [
        { name: "gmail", scope: "connector", transport: "stdio", connectorId: "connector_gmail" },
      ],
      knownMcp: [
        { name: "gmail", scope: "connector", connectorId: "connector_gmail" },
        { name: "drive", scope: "connector", connectorId: "connector_drive" },
      ],
    });
    const joined = inv.args.join("\n");
    expect(joined).toContain("features.apps=true");
    expect(joined).toContain("apps.default.enabled=false");
    expect(joined).toContain("apps.connector_gmail.enabled=true");
    expect(joined).not.toContain("connector_drive");
    expect(joined).not.toContain("features.apps=false");
  });

  it("keeps connector selection usable without a knownMcp list", () => {
    const inv = planned({
      extraMcp: [
        { name: "gmail", scope: "connector", transport: "stdio", connectorId: "connector_gmail" },
      ],
    });
    expect(inv.args.join("\n")).toContain("apps.connector_gmail.enabled=true");
  });

  it("maps the shell toggle without touching the sandbox mode", () => {
    const writable = {
      network: true,
      write: ["workspace"] as ("workspace" | "project")[],
      extraReadDirs: [] as string[],
    };
    const off = planned({ permissions: { ...writable, shell: false } });
    expect(off.args.join("\n")).toContain("features.shell_tool=false");
    expect(off.args.join(" ")).toContain("--sandbox workspace-write");
    const on = planned({ permissions: { ...writable, shell: true } });
    expect(on.args.join("\n")).not.toContain("features.shell_tool");
    expect(on.args.join(" ")).toContain("--sandbox workspace-write");
    const legacy = planned({ permissions: { network: false, write: [], extraReadDirs: [] } });
    expect(legacy.args.join("\n")).not.toContain("features.shell_tool");
    expect(legacy.args.join(" ")).toContain("--sandbox read-only");
  });

  it("rejects unsafe names, relay, duplicates and missing launch details", () => {
    const adapter = createAdapter("codex");
    const bad = [
      { extraMcp: [{ name: "evil.name", scope: "global", transport: "stdio", command: "x" }] },
      { extraMcp: [{ name: "relay", scope: "global", transport: "stdio", command: "x" }] },
      {
        extraMcp: [
          { name: "dup", scope: "global", transport: "stdio", command: "x" },
          { name: "dup", scope: "global", transport: "stdio", command: "y" },
        ],
      },
      { extraMcp: [{ name: "nocmd", scope: "global", transport: "stdio" }] },
      { extraMcp: [{ name: "nourl", scope: "global", transport: "http" }] },
      { extraMcp: [{ name: "conn", scope: "connector", transport: "stdio" }] },
      { knownMcp: [{ name: "evil name", scope: "global" }] },
    ] as Parameters<typeof request>[0][];
    for (const overrides of bad) {
      expect(adapter.plan(request(overrides)).ok).toBe(false);
    }
  });

  it("rejects secret env collisions instead of silently overriding", () => {
    const adapter = createAdapter("codex");
    expect(
      adapter.plan(
        request({
          extraMcp: [
            {
              name: "fixture",
              scope: "global",
              transport: "stdio",
              command: "x",
              env: { RELAY_EXEC_TOKEN: "something-else" },
            },
          ],
        }),
      ).ok,
    ).toBe(false);
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
