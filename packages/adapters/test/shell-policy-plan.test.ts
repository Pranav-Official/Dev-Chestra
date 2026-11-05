import { describe, expect, it } from "vitest";
import { type CliAdapter, createAdapter } from "../src/index.js";
import { request } from "./helpers.js";

const POLICY = { allow: ["^rg .+$"], timeoutSec: 60, maxOutputBytes: 262144 };

function flagValue(args: readonly string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return [];
  return (args[index + 1] ?? "").split(",");
}

function plannedFor(
  id: "claude-code" | "codex" | "opencode" | "pi",
  permissions: Record<string, unknown>,
  extra: Partial<Parameters<typeof request>[0]> = {},
) {
  const adapter: CliAdapter = createAdapter(id);
  const result = adapter.plan(
    request({
      permissions: { network: false, write: ["workspace"], extraReadDirs: [], ...permissions },
      ...extra,
    } as Parameters<typeof request>[0]),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("plan failed");
  return result.value;
}

describe("shell policy disables the native shell in every adapter", () => {
  for (const shell of [true, undefined] as const) {
    const label = shell === undefined ? "shell undefined" : "shell true";
    const withShell = shell === undefined ? {} : { shell };

    it(`claude removes Bash from allowed and denies it (${label})`, () => {
      const inv = plannedFor("claude-code", { ...withShell, shellPolicy: POLICY });
      expect(flagValue(inv.args, "--disallowedTools")).toContain("Bash");
      expect(flagValue(inv.args, "--allowedTools")).not.toContain("Bash");
      expect(flagValue(inv.args, "--allowedTools")).toContain("mcp__devchestra__*");
    });

    it(`claude refuses cliOptions allowedTools=Bash under a policy (${label})`, () => {
      const adapter = createAdapter("claude-code");
      const result = adapter.plan(
        request({
          permissions: {
            network: false,
            write: ["workspace"],
            extraReadDirs: [],
            ...withShell,
            shellPolicy: POLICY,
          },
          cliOptions: { allowedTools: ["Bash"] },
        }),
      );
      expect(result.ok).toBe(false);
    });

    it(`codex sets features.shell_tool=false (${label})`, () => {
      const inv = plannedFor("codex", { ...withShell, shellPolicy: POLICY });
      expect(inv.args.join("\n")).toContain("features.shell_tool=false");
    });

    it(`opencode denies bash in the inline config (${label})`, () => {
      const inv = plannedFor("opencode", { ...withShell, shellPolicy: POLICY });
      const content = inv.env.OPENCODE_CONFIG_CONTENT ?? "";
      expect(JSON.parse(content).permission).toEqual({ bash: "deny" });
    });

    it(`pi excludes bash and powershell (${label})`, () => {
      const inv = plannedFor("pi", { ...withShell, shellPolicy: POLICY });
      const excluded = flagValue(inv.args, "--exclude-tools");
      expect(excluded).toContain("bash");
      expect(excluded).toContain("powershell");
    });
  }

  it("keeps the legacy plans unchanged without a policy", () => {
    const claude = plannedFor("claude-code", { shell: true });
    expect(flagValue(claude.args, "--allowedTools")).toContain("Bash");
    const codex = plannedFor("codex", { shell: true });
    expect(codex.args.join("\n")).not.toContain("features.shell_tool");
    const opencode = plannedFor("opencode", { shell: true });
    expect(opencode.env.OPENCODE_CONFIG_CONTENT ?? "").not.toContain('"bash"');
    const pi = plannedFor("pi", { shell: true });
    expect(flagValue(pi.args, "--exclude-tools")).not.toContain("bash");
  });

  it("sizes the codex MCP tool timeout to the policy deadline", () => {
    const short = plannedFor("codex", { shellPolicy: POLICY });
    expect(short.args.join("\n")).toContain("mcp_servers.devchestra.tool_timeout_sec=120");
    const long = plannedFor("codex", { shellPolicy: { ...POLICY, timeoutSec: 600 } });
    expect(long.args.join("\n")).toContain("mcp_servers.devchestra.tool_timeout_sec=630");
  });
});
