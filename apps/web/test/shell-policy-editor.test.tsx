import type { AgentNode, ShellPolicy } from "@devchestra/schema";
import { evaluateShellPolicy, validateShellPolicy } from "@devchestra/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentTools, effectiveShell } from "../src/editor/inspector/AgentTools.js";
import type { McpServersClient } from "../src/editor/inspector/model/mcp-servers.js";
import { ShellPolicyEditor } from "../src/editor/inspector/ShellPolicyEditor.js";
import { SHELL_POLICY_PRESETS } from "../src/editor/inspector/shellPolicyModel.js";

const base: AgentNode = {
  id: "node-agent",
  type: "agent",
  name: "Research",
  cli: "codex",
  prompt: "Find the facts.",
  output: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
  permissions: { network: false, write: [] },
  workspace: { mode: "scratch" },
};

function withPolicy(policy: ShellPolicy | undefined, extra: Partial<AgentNode> = {}): AgentNode {
  return {
    ...base,
    ...extra,
    permissions: {
      network: false,
      write: [],
      shell: true,
      ...(policy === undefined ? {} : { shellPolicy: policy }),
    },
  };
}

/** Returns the most recent permissions patch emitted by the editor. */
function lastPermissions(onPatch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const patch = onPatch.mock.lastCall?.[0] as { permissions?: Record<string, unknown> };
  return patch.permissions ?? {};
}

/** Applies each patch to local state, the way the inspector's editor model does. */
function StatefulEditor({ initial, spy }: { initial: AgentNode; spy: (patch: unknown) => void }) {
  const [node, setNode] = useState(initial);
  return (
    <ShellPolicyEditor
      node={node}
      onPatch={(patch) => {
        spy(patch);
        setNode((previous) => ({ ...previous, ...patch }) as AgentNode);
      }}
    />
  );
}

function renderEditor(node: AgentNode) {
  const onPatch = vi.fn();
  render(<StatefulEditor initial={node} spy={onPatch} />);
  return onPatch;
}

function typeCommand(command: string): void {
  fireEvent.change(screen.getByTestId("shell-policy-tester-command"), {
    target: { value: command },
  });
  fireEvent.click(screen.getByTestId("shell-policy-tester-run"));
}

describe("ShellPolicyEditor presets", () => {
  it("ships presets that pass the exported schema validator", () => {
    for (const preset of SHELL_POLICY_PRESETS) {
      expect(validateShellPolicy({ allow: preset.allow, deny: preset.deny })).toEqual([]);
    }
  });

  it("replaces rules with a preset and keeps timeout and output limits", () => {
    const onPatch = renderEditor(
      withPolicy({ allow: ["^ls$"], timeoutSec: 30, maxOutputBytes: 4096 }),
    );
    fireEvent.click(screen.getByTestId("inspector-shell-policy-preset-web-research"));
    const policy = lastPermissions(onPatch).shellPolicy as ShellPolicy;
    const web = SHELL_POLICY_PRESETS.find((preset) => preset.id === "web-research");
    expect(policy).toEqual({
      allow: web?.allow,
      deny: web?.deny,
      timeoutSec: 30,
      maxOutputBytes: 4096,
    });
  });
});

describe("ShellPolicyEditor rows", () => {
  it("adds an empty row that is flagged until it has a pattern", () => {
    const onPatch = renderEditor(withPolicy({ allow: ["^ls$"] }));
    fireEvent.click(screen.getByTestId("inspector-shell-policy-deny-add"));
    expect(lastPermissions(onPatch).shellPolicy).toEqual({ allow: ["^ls$"], deny: [""] });
    expect(screen.queryByTestId("inspector-shell-policy-deny-0")).toBeInTheDocument();
  });

  it("commits a valid edit and removes a row", () => {
    const onPatch = renderEditor(withPolicy({ allow: ["^ls$", "^pwd$"] }));
    fireEvent.change(screen.getByTestId("inspector-shell-policy-allow-1"), {
      target: { value: "^whoami$" },
    });
    expect(lastPermissions(onPatch).shellPolicy).toEqual({ allow: ["^ls$", "^whoami$"] });

    fireEvent.click(screen.getByTestId("inspector-shell-policy-allow-remove-0"));
    expect(lastPermissions(onPatch).shellPolicy).toEqual({ allow: ["^whoami$"] });
  });

  it("persists invalid text so validation and preview cannot use an old rule", () => {
    const onPatch = renderEditor(withPolicy({ allow: ["^ls$"] }));
    fireEvent.change(screen.getByTestId("inspector-shell-policy-allow-0"), {
      target: { value: "(unclosed" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Pattern 1 is not a supported RE2 regular expression/,
    );
    expect(screen.getByTestId("inspector-shell-policy-allow-0")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(lastPermissions(onPatch).shellPolicy).toEqual({ allow: ["(unclosed"] });
  });

  it("flags nested-quantifier ReDoS shapes through the schema check", () => {
    const onPatch = renderEditor(withPolicy({ deny: [] }));
    fireEvent.click(screen.getByTestId("inspector-shell-policy-deny-add"));
    fireEvent.change(screen.getByTestId("inspector-shell-policy-deny-0"), {
      target: { value: "(a+)+b" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/nested-quantifier/);
    expect(onPatch).toHaveBeenCalledTimes(2);
  });
});

describe("ShellPolicyEditor tester", () => {
  it("denies a deny-matched command before the allow list is consulted", () => {
    renderEditor(
      withPolicy({ allow: ["^rg [^;|&<>$`]+$"], deny: ["^rg\\b.*\\s--pre(\\s.*|=.*|$)"] }),
    );
    typeCommand("rg --pre sh needle");
    expect(screen.getByTestId("shell-policy-tester-deny")).toHaveTextContent(/Denied by deny rule/);
    expect(screen.getByTestId("shell-policy-tester-deny")).toHaveTextContent(
      "^rg\\b.*\\s--pre(\\s.*|=.*|$)",
    );
  });

  it("allows a matching command and shows the canonical argv", () => {
    renderEditor(withPolicy({ allow: ["^rg [^;|&<>$`]+$"] }));
    typeCommand('rg -n "needle here" src');
    expect(screen.getByTestId("shell-policy-tester-allow")).toBeInTheDocument();
    expect(screen.getByTestId("shell-policy-tester-argv")).toHaveTextContent(
      'Canonical argv: ["rg","-n","needle here","src"]',
    );
  });

  it("denies everything that matches no allow rule", () => {
    renderEditor(withPolicy({ allow: ["^ls$"] }));
    typeCommand("pwd");
    expect(screen.getByTestId("shell-policy-tester-deny")).toHaveTextContent(
      "command matched no allow rule.",
    );
  });

  it("treats an empty allow list as a denylist", () => {
    renderEditor(withPolicy({ allow: [], deny: ["^rm\\b.*$"] }));
    typeCommand("ls -la");
    expect(screen.getByTestId("shell-policy-tester-allow")).toBeInTheDocument();
    typeCommand("rm -rf build");
    expect(screen.getByTestId("shell-policy-tester-deny")).toHaveTextContent("Denied by deny rule");
  });

  it("requires patterns to match the whole command, so a bare prefix does not deny", () => {
    renderEditor(withPolicy({ allow: [], deny: ["^rm\\b"] }));
    typeCommand("rm -rf build");
    expect(screen.getByTestId("shell-policy-tester-allow")).toBeInTheDocument();
  });

  it("makes each preset deny rule fire on the risk it names", () => {
    const sample = (id: string) => {
      const preset = SHELL_POLICY_PRESETS.find((entry) => entry.id === id);
      if (preset === undefined) throw new Error(`missing preset ${id}`);
      return { allow: preset.allow, deny: preset.deny };
    };
    const cases: Array<[string, string, "allow" | "deny"]> = [
      ["web-research", "curl -sS https://example.com", "allow"],
      ["web-research", "curl -sS https://example.com -o out.bin", "deny"],
      ["web-research", "curl -o out.bin https://example.com", "deny"],
      ["web-research", "rg --pre sh needle", "deny"],
      ["web-research", "rg needle docs", "allow"],
      ["web-research", "python3 -c print", "deny"],
      ["read-only-git", "git status", "allow"],
      ["read-only-git", "git diff --stat", "allow"],
      ["read-only-git", "git diff --output=out.patch", "deny"],
      ["read-only-git", "git push origin main", "deny"],
      ["repo-search", "rg needle src", "allow"],
      ["repo-search", "git grep -O less needle", "deny"],
      ["repo-search", "git grep -nOsh needle", "deny"],
      ["repo-search", "git grep needle", "allow"],
      ["repo-search", "env rg needle", "deny"],
    ];
    for (const [id, command, expected] of cases) {
      const decision = evaluateShellPolicy(sample(id), command);
      expect(decision.allow, `${id}: ${command}`).toBe(expected === "allow");
    }
  });

  it("hides previous results while a visible deny rule is invalid", () => {
    renderEditor(withPolicy({ deny: ["^rm .*$"] }));
    typeCommand("ls");
    expect(screen.getByTestId("shell-policy-tester-allow")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("inspector-shell-policy-deny-0"), {
      target: { value: "(" },
    });
    expect(screen.getByTestId("shell-policy-tester-run")).toBeDisabled();
    expect(screen.queryByTestId("shell-policy-tester-allow")).toBeNull();
  });

  it("rejects compounds, redirects and expansion without running anything", () => {
    renderEditor(withPolicy({ allow: ["^curl\\b.*$"] }));
    typeCommand("curl x; rm y");
    expect(screen.getByTestId("shell-policy-tester-deny")).toHaveTextContent("unquoted ';'");
    typeCommand("curl $(whoami)");
    expect(screen.getByTestId("shell-policy-tester-deny")).toHaveTextContent("'$' or backticks");
  });

  it("says the preview never runs the command", () => {
    renderEditor(withPolicy({ allow: ["^ls$"] }));
    expect(screen.getByTestId("shell-policy-tester-preview")).toHaveTextContent(
      "Preview only; command not executed.",
    );
  });

  it("refuses to check while a rule is invalid, without throwing", () => {
    renderEditor(withPolicy({ allow: ["(unclosed"] }));
    expect(screen.getByTestId("shell-policy-tester-run")).toBeDisabled();
    fireEvent.change(screen.getByTestId("shell-policy-tester-command"), {
      target: { value: "ls" },
    });
    expect(screen.queryByTestId("shell-policy-tester-allow")).toBeNull();
    expect(screen.queryByTestId("shell-policy-tester-deny")).toBeNull();
  });
});

describe("ShellPolicyEditor copy and warnings", () => {
  it("states it is not an OS sandbox and names the bypasses", () => {
    renderEditor(withPolicy({ allow: ["^ls$"] }));
    const note = screen.getByTestId("inspector-shell-policy-sandbox");
    expect(note).toHaveTextContent("Not an OS sandbox.");
    expect(note).toHaveTextContent(/python/);
    expect(note).toHaveTextContent(/find -exec/);
    expect(note).toHaveTextContent(/MCP servers/);
    expect(note).toHaveTextContent(/not a complete security boundary/);
  });

  it("warns when extra MCP servers are selected alongside a policy", () => {
    renderEditor(
      withPolicy({ allow: ["^ls$"] }, { mcpServers: [{ name: "neon", scope: "global" }] }),
    );
    expect(screen.getByTestId("inspector-shell-policy-mcp-warning")).toHaveTextContent(/neon/);
  });

  it("shows no MCP warning without extra servers", () => {
    renderEditor(withPolicy({ allow: ["^ls$"] }));
    expect(screen.queryByTestId("inspector-shell-policy-mcp-warning")).toBeNull();
  });
});

describe("ShellPolicyEditor restriction toggle", () => {
  it("enabling restriction makes shell explicit and adds an empty policy", () => {
    const onPatch = renderEditor({
      ...base,
      permissions: { network: false, write: [] },
    });
    fireEvent.click(screen.getByTestId("inspector-shell-policy-toggle"));
    const permissions = lastPermissions(onPatch);
    expect(permissions.shell).toBe(true);
    expect(permissions.shellPolicy).toEqual({ allow: [], deny: [] });
  });

  it("preserves shell enabled implicitly by a policy when restrictions are removed", () => {
    const onPatch = renderEditor({
      ...base,
      permissions: { network: false, write: [], shellPolicy: { allow: ["^ls$"] } },
    });
    fireEvent.click(screen.getByTestId("inspector-shell-policy-toggle"));
    expect(lastPermissions(onPatch)).toEqual({ network: false, write: [], shell: true });
  });

  it("clearing restriction removes shellPolicy and leaves shell alone", () => {
    const onPatch = renderEditor(withPolicy({ allow: ["^ls$"] }));
    fireEvent.click(screen.getByTestId("inspector-shell-policy-toggle"));
    const permissions = lastPermissions(onPatch);
    expect(permissions.shellPolicy).toBeUndefined();
    expect(permissions.shell).toBe(true);
  });
});

describe("effectiveShell", () => {
  it("treats a present policy as shell on even when write is empty and shell is omitted", () => {
    expect(effectiveShell(withPolicy({ allow: ["^ls$"] }))).toBe(true);
    expect(
      effectiveShell({
        ...base,
        permissions: { network: false, write: [], shellPolicy: { allow: ["^ls$"] } },
      }),
    ).toBe(true);
  });

  it("keeps the legacy write-derived value when no policy is set", () => {
    expect(effectiveShell(base)).toBe(false);
    expect(effectiveShell({ ...base, permissions: { network: false, write: ["workspace"] } })).toBe(
      true,
    );
  });

  it("lets an explicit shell:false win", () => {
    expect(
      effectiveShell({
        ...base,
        permissions: { network: false, write: ["workspace"], shell: false },
      }),
    ).toBe(false);
  });
});

describe("AgentTools shell toggle with a policy", () => {
  const noMcp: McpServersClient = {
    getCliMcpServers: vi.fn().mockResolvedValue({
      cli: "codex",
      projectId: "p1",
      servers: [],
      scanned: [],
      warnings: [],
    }),
  };

  it("turning shell off clears the policy so shell:false never carries rules", () => {
    const onPatch = vi.fn();
    render(
      <AgentTools
        node={withPolicy({ allow: ["^ls$"] })}
        projectId="p1"
        onPatch={onPatch}
        mcpClient={noMcp}
      />,
    );
    fireEvent.click(screen.getByTestId("inspector-tools-shell"));
    const permissions = lastPermissions(onPatch);
    expect(permissions.shell).toBe(false);
    expect(permissions.shellPolicy).toBeUndefined();
  });

  it("shows the shell checkbox on when a policy exists with empty write", () => {
    render(
      <AgentTools
        node={{
          ...base,
          permissions: { network: false, write: [], shellPolicy: { allow: ["^ls$"] } },
        }}
        projectId="p1"
        onPatch={vi.fn()}
        mcpClient={noMcp}
      />,
    );
    expect(screen.getByTestId("inspector-tools-shell")).toBeChecked();
    expect(screen.getByTestId("inspector-shell-policy-toggle")).toBeChecked();
  });
});
