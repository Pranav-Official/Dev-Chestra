import { describe, expect, it } from "vitest";
import {
  evaluateShellPolicy,
  hashWorkflow,
  normalizeShellPolicy,
  normalizeWorkflow,
  parseWorkflow,
  SHELL_POLICY_MAX_COMMAND_BYTES,
  SHELL_POLICY_MAX_OUTPUT_BYTES_MAX,
  SHELL_POLICY_MAX_PATTERN_LENGTH,
  SHELL_POLICY_MAX_RULES,
  SHELL_POLICY_TIMEOUT_SEC_MAX,
  type ShellPolicy,
  tokenizeShellCommand,
  validateShellPolicy,
  validateWorkflow,
} from "../src/index.js";
import { chainRaw, clone, node, parseOk } from "./helpers.js";

function agentPermissions(raw: Record<string, unknown>): Record<string, unknown> {
  return node(raw, "agent").permissions as Record<string, unknown>;
}

function withPolicy(policy: unknown): Record<string, unknown> {
  const raw = chainRaw();
  agentPermissions(raw).shellPolicy = policy;
  return raw;
}

function errorPointers(raw: Record<string, unknown>): string[] {
  const report = validateWorkflow(parseOk(raw));
  return report.errors.map((item) => `${item.code} ${item.pointer}`);
}

function normalizedPolicy(raw: Record<string, unknown>): ShellPolicy {
  const result = normalizeWorkflow(parseOk(raw));
  if (!result.ok) throw result.error;
  const agent = result.value.graph.nodes.find((item) => item.id === "agent");
  if (agent?.type !== "agent") throw new Error("missing agent node");
  return agent.permissions.shellPolicy as ShellPolicy;
}

describe("shellPolicy schema shape", () => {
  it("parses allow-only, deny-only, combined, limits and empty policies", () => {
    const cases: ShellPolicy[] = [
      { allow: ["^curl .+$"] },
      { deny: ["rm .*"] },
      { allow: ["^curl .+$"], deny: ["\\s-o\\s"] },
      { allow: ["a"], deny: ["b"], timeoutSec: 60, maxOutputBytes: 262144 },
      {},
    ];
    for (const policy of cases) {
      const parsed = parseWorkflow(withPolicy(policy));
      expect(parsed.ok, JSON.stringify(policy)).toBe(true);
    }
  });

  it("rejects unknown keys in the strict policy and permission objects", () => {
    const nested = withPolicy({ allow: ["a"], bogus: true });
    expect(parseWorkflow(nested).ok).toBe(false);

    const flat = chainRaw();
    agentPermissions(flat).shellPolicy = { allow: ["a"] };
    (agentPermissions(flat) as Record<string, unknown>).extra = true;
    expect(parseWorkflow(flat).ok).toBe(false);
  });

  it("requires shell to be enabled when a policy is present", () => {
    const denied = withPolicy({ allow: ["^curl .+$"] });
    agentPermissions(denied).shell = false;
    const pointers = errorPointers(denied);
    expect(pointers).toContain("E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy");

    const enabled = withPolicy({ allow: ["^curl .+$"] });
    agentPermissions(enabled).shell = true;
    expect(validateWorkflow(parseOk(enabled)).ok).toBe(true);

    const omitted = withPolicy({ allow: ["^curl .+$"] });
    expect(validateWorkflow(parseOk(omitted)).ok).toBe(true);

    const omittedInvalid = withPolicy({ allow: ["("] });
    expect(errorPointers(omittedInvalid)).toContain(
      "E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/allow/0",
    );
  });
});

describe("shellPolicy semantic validation", () => {
  it("accepts compiling anchored patterns and rejects non-compiling ones", () => {
    for (const pattern of ["^curl .+$", "rg .+", "\\s(-o|--output)(\\s|$)", "a"]) {
      const report = validateWorkflow(parseOk(withPolicy({ allow: [pattern] })));
      expect(report.ok, pattern).toBe(true);
    }
    for (const pattern of ["(", "[a-", "*foo", "(?<unclosed>"]) {
      const pointers = errorPointers(withPolicy({ deny: [pattern] }));
      expect(pointers, pattern).toContain(
        `E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/deny/0`,
      );
    }
    expect(validateShellPolicy({ allow: ["("] })).toHaveLength(1);
    expect(validateShellPolicy({ deny: [""] })).toHaveLength(1);
  });

  it("enforces the 512-character pattern cap", () => {
    const atCap = withPolicy({ allow: ["x".repeat(SHELL_POLICY_MAX_PATTERN_LENGTH)] });
    expect(validateWorkflow(parseOk(atCap)).ok).toBe(true);

    const overCap = withPolicy({ deny: ["x".repeat(SHELL_POLICY_MAX_PATTERN_LENGTH + 1)] });
    expect(errorPointers(overCap)).toContain(
      `E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/deny/0`,
    );
  });

  it("enforces the 50-rule combined cap", () => {
    const fifty = withPolicy({
      allow: Array.from({ length: 25 }, (_, index) => `allow-${index} .*`),
      deny: Array.from({ length: 25 }, (_, index) => `deny-${index} .*`),
    });
    expect(validateWorkflow(parseOk(fifty)).ok).toBe(true);

    const fiftyOne = withPolicy({
      allow: Array.from({ length: 26 }, (_, index) => `allow-${index} .*`),
      deny: Array.from({ length: 25 }, (_, index) => `deny-${index} .*`),
    });
    expect(errorPointers(fiftyOne)).toContain(
      "E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy",
    );
    expect(SHELL_POLICY_MAX_RULES).toBe(50);
  });

  it("rejects obvious nested-quantifier ReDoS shapes and keeps linear ones", () => {
    for (const pattern of ["(a+)+", "(.*a)+", "(?:\\d+)*", "(a+)+$", "(a|b+)*"]) {
      const pointers = errorPointers(withPolicy({ allow: [pattern] }));
      expect(pointers, pattern).toContain(
        "E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/allow/0",
      );
    }
    for (const pattern of [
      "curl .*",
      "(ab|cd)+",
      "(ab){2}",
      "a+",
      "\\d+\\.\\d+",
      "[+]+",
      "git (log|show) .*",
    ]) {
      const report = validateWorkflow(parseOk(withPolicy({ allow: [pattern] })));
      expect(report.ok, pattern).toBe(true);
    }
  });

  it("validates timeoutSec and maxOutputBytes as positive finite integers", () => {
    for (const value of [1, 60, SHELL_POLICY_TIMEOUT_SEC_MAX]) {
      expect(validateWorkflow(parseOk(withPolicy({ timeoutSec: value }))).ok).toBe(true);
    }
    for (const value of [0, -5, 1.5, SHELL_POLICY_TIMEOUT_SEC_MAX + 1]) {
      const pointers = errorPointers(withPolicy({ timeoutSec: value }));
      expect(pointers, String(value)).toContain(
        "E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/timeoutSec",
      );
    }
    expect(parseWorkflow(withPolicy({ timeoutSec: "60" })).ok).toBe(false);
    expect(parseWorkflow(withPolicy({ timeoutSec: Number.NaN })).ok).toBe(false);
    for (const value of [1, 262144, SHELL_POLICY_MAX_OUTPUT_BYTES_MAX]) {
      expect(validateWorkflow(parseOk(withPolicy({ maxOutputBytes: value }))).ok).toBe(true);
    }
    for (const value of [0, -1, 2.5, SHELL_POLICY_MAX_OUTPUT_BYTES_MAX + 1]) {
      const pointers = errorPointers(withPolicy({ maxOutputBytes: value }));
      expect(pointers, String(value)).toContain(
        "E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/maxOutputBytes",
      );
    }
    expect(parseWorkflow(withPolicy({ maxOutputBytes: "big" })).ok).toBe(false);
  });

  it("reports non-array and non-string policy fields", () => {
    const file = parseOk(chainRaw());
    const raw = clone(file) as unknown as Record<string, unknown>;
    node(raw, "agent").permissions = {
      network: false,
      write: [],
      shellPolicy: { allow: "curl .*", timeoutSec: "tilt" },
    };
    const report = validateWorkflow(raw as unknown as Parameters<typeof validateWorkflow>[0]);
    const pointers = report.errors.map((item) => `${item.code} ${item.pointer}`);
    expect(pointers).toContain("E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/allow");
    expect(pointers).toContain("E_SHELL_POLICY /graph/nodes/1/permissions/shellPolicy/timeoutSec");
  });
});

describe("shellPolicy tokenization", () => {
  it("splits POSIX words with quotes and backslash", () => {
    const cases: Array<[string, string[]]> = [
      ["git status", ["git", "status"]],
      ["git   log --oneline", ["git", "log", "--oneline"]],
      ["echo\t-a", ["echo", "-a"]],
      [`echo "hello world"`, ["echo", "hello world"]],
      ["echo 'hello world'", ["echo", "hello world"]],
      ["echo it\\'s", ["echo", "it's"]],
      ["echo a\\ b", ["echo", "a b"]],
      [`echo "a;b" 'c|d'`, ["echo", "a;b", "c|d"]],
      ['echo "a\'b"', ["echo", "a'b"]],
      ["echo 'a\"b'", ["echo", 'a"b']],
      [`echo "a\\"b"`, ["echo", 'a"b']],
      ["echo a\\;b", ["echo", "a;b"]],
      ['echo "a\\b"', ["echo", "a\\b"]],
      ["echo FOO=bar", ["echo", "FOO=bar"]],
    ];
    for (const [command, argv] of cases) {
      expect(tokenizeShellCommand(command), command).toEqual({ ok: true, argv });
    }
  });

  it("rejects each unquoted metacharacter and allows it quoted", () => {
    const metas = [";", "&", "|", "<", ">", "(", ")", "{", "}", "*", "?", "~", "!", "#"];
    for (const meta of metas) {
      const bare = tokenizeShellCommand(`echo a${meta}b`);
      expect(bare.ok, `unquoted ${meta}`).toBe(false);
      for (const quoted of [`echo "a${meta}b"`, `echo 'a${meta}b'`]) {
        const result = tokenizeShellCommand(quoted);
        expect(result, `${meta} in ${quoted[5] === '"' ? "double" : "single"} quotes`).toEqual({
          ok: true,
          argv: ["echo", `a${meta}b`],
        });
      }
    }
    expect(tokenizeShellCommand("echo # comment").ok).toBe(false);
    expect(tokenizeShellCommand("echo hi!").ok).toBe(false);
    expect(tokenizeShellCommand('echo "hi!"').ok).toBe(true);
  });

  it("rejects $ and backticks everywhere, even quoted or escaped", () => {
    const cases = [
      "echo $HOME",
      "echo $" + "{HOME}",
      "echo `$HOME`",
      "echo hi`there`",
      'echo "$HOME"',
      "echo '$HOME'",
      'echo "a`b`"',
      "echo \\$HOME",
      'echo "\\$HOME"',
    ];
    for (const command of cases) {
      const result = tokenizeShellCommand(command);
      expect(result.ok, command).toBe(false);
      if (!result.ok) expect(result.reason).toContain("$");
    }
  });

  it("rejects newlines, empty commands and malformed quoting", () => {
    expect(tokenizeShellCommand("echo a\nb").ok).toBe(false);
    expect(tokenizeShellCommand("echo a\rb").ok).toBe(false);
    expect(tokenizeShellCommand("echo 'a\nb'").ok).toBe(false);
    expect(tokenizeShellCommand("").ok).toBe(false);
    expect(tokenizeShellCommand("   ").ok).toBe(false);
    expect(tokenizeShellCommand("echo 'oops").ok).toBe(false);
    expect(tokenizeShellCommand('echo "oops').ok).toBe(false);
    expect(tokenizeShellCommand("echo last\\").ok).toBe(false);
  });
});

describe("shellPolicy evaluation", () => {
  it("denies env-prefix assignments and slash programs", () => {
    expect(evaluateShellPolicy(undefined, "FOO=1 curl https://x")).toMatchObject({ allow: false });
    expect(evaluateShellPolicy(undefined, "./run.sh")).toMatchObject({ allow: false });
    expect(evaluateShellPolicy(undefined, "/bin/ls -la")).toMatchObject({ allow: false });
    expect(evaluateShellPolicy(undefined, "a/b arg")).toMatchObject({ allow: false });
    expect(evaluateShellPolicy(undefined, "git status")).toEqual({
      allow: true,
      argv: ["git", "status"],
    });
  });

  it("checks deny before allow", () => {
    const policy: ShellPolicy = { allow: [".*"], deny: ["rm .*"] };
    const denied = evaluateShellPolicy(policy, "rm -rf /tmp/x");
    expect(denied).toMatchObject({ allow: false, rule: "rm .*" });
    if (!denied.allow) expect(denied.reason).toContain("deny");
    expect(evaluateShellPolicy(policy, "ls -la")).toEqual({ allow: true, argv: ["ls", "-la"] });
  });

  it("treats non-empty allow as an allowlist and empty allow as a denylist", () => {
    const list: ShellPolicy = { allow: ["curl .*"] };
    expect(evaluateShellPolicy(list, "curl https://example.com")).toMatchObject({ allow: true });
    const missed = evaluateShellPolicy(list, "wget https://example.com");
    expect(missed.allow).toBe(false);
    if (!missed.allow) {
      expect(missed.reason).toContain("no allow rule");
      expect("rule" in missed).toBe(false);
    }

    const denylist: ShellPolicy = { allow: [], deny: ["rm .*"] };
    expect(evaluateShellPolicy(denylist, "rm x")).toMatchObject({ allow: false });
    expect(evaluateShellPolicy(denylist, "ls")).toMatchObject({ allow: true });
  });

  it("treats absent or empty policy as plain parsed shell", () => {
    const empties: Array<ShellPolicy | undefined> = [undefined, {}, { allow: [], deny: [] }];
    for (const policy of empties) {
      expect(evaluateShellPolicy(policy, "git status")).toEqual({
        allow: true,
        argv: ["git", "status"],
      });
      expect(evaluateShellPolicy(policy, "git log; rm x").allow).toBe(false);
      expect(evaluateShellPolicy(policy, "").allow).toBe(false);
    }
  });

  it("anchors patterns to the full canonical command", () => {
    const policy: ShellPolicy = { allow: ["curl"] };
    expect(evaluateShellPolicy(policy, "curl").allow).toBe(true);
    expect(evaluateShellPolicy(policy, "curl https://example.com").allow).toBe(false);

    const args: ShellPolicy = { allow: ["curl https://[^ ]+"] };
    expect(evaluateShellPolicy(args, "curl    https://example.com").allow).toBe(true);
    expect(evaluateShellPolicy(args, "curl https://example.com extra").allow).toBe(false);
  });

  it("preserves argument boundaries and handles ambiguous alternation safely", () => {
    const policy = { deny: ["git commit -m message --amend"] };
    expect(evaluateShellPolicy(policy, 'git commit -m "message --amend"').allow).toBe(true);
    expect(evaluateShellPolicy(policy, "git commit -m message --amend").allow).toBe(false);
    expect(evaluateShellPolicy({ allow: ["(a|aa)+"] }, `${"a".repeat(4000)}b`).allow).toBe(false);
    expect(evaluateShellPolicy({ deny: ["(?=x)x"] }, "x").allow).toBe(false);
  });

  it("caps commands at 4 KiB in UTF-8 bytes before matching", () => {
    expect(SHELL_POLICY_MAX_COMMAND_BYTES).toBe(4096);
    const atCap = "x".repeat(4096);
    expect(new TextEncoder().encode(atCap).length).toBe(4096);
    expect(evaluateShellPolicy(undefined, atCap)).toEqual({ allow: true, argv: [atCap] });
    expect(evaluateShellPolicy(undefined, `${atCap}x`).allow).toBe(false);

    // Multibyte: 2048 e-acutes are exactly 4096 bytes; char count alone would pass.
    const wideAtCap = "é".repeat(2048);
    expect(wideAtCap.length).toBe(2048);
    expect(new TextEncoder().encode(wideAtCap).length).toBe(4096);
    expect(evaluateShellPolicy(undefined, wideAtCap).allow).toBe(true);
    expect(evaluateShellPolicy(undefined, `${wideAtCap}é`).allow).toBe(false);
    // 3000 chars but 6000 bytes: denied on bytes, not chars.
    expect(evaluateShellPolicy(undefined, "é".repeat(3000)).allow).toBe(false);
  });
});

describe("shellPolicy normalization and hashing", () => {
  it("sorts and dedupes allow/deny, preserves limits and shell omission", () => {
    const raw = withPolicy({
      deny: ["rm .*", "curl .*", "rm .*"],
      allow: ["rg .+", "curl .*", "curl .*"],
      timeoutSec: 60,
      maxOutputBytes: 262144,
    });
    const policy = normalizedPolicy(raw);
    expect(policy).toEqual({
      allow: ["curl .*", "rg .+"],
      deny: ["curl .*", "rm .*"],
      timeoutSec: 60,
      maxOutputBytes: 262144,
    });
    expect(normalizeShellPolicy({})).toEqual({});
  });

  it("keeps hashes stable across rule order and changes them with policy", async () => {
    const base = normalizeWorkflow(parseOk(withPolicy({ allow: ["b .*", "a .*"] })));
    if (!base.ok) throw base.error;
    const baseHash = await hashWorkflow(base.value);

    const reordered = withPolicy({ allow: ["a .*", "b .*"] });
    const reorderedResult = normalizeWorkflow(parseOk(reordered));
    if (!reorderedResult.ok) throw reorderedResult.error;
    expect(await hashWorkflow(reorderedResult.value)).toBe(baseHash);

    const changed = withPolicy({ allow: ["a .*"] });
    const changedResult = normalizeWorkflow(parseOk(changed));
    if (!changedResult.ok) throw changedResult.error;
    expect(await hashWorkflow(changedResult.value)).not.toBe(baseHash);
  });

  it("gives poll probes the same permissions shape", () => {
    const raw = chainRaw();
    const start = node(raw, "start");
    start.polling = {
      enabled: true,
      probe: {
        type: "agent",
        cli: "codex",
        prompt: "Check for new work.",
        permissions: {
          network: false,
          write: [],
          shellPolicy: { deny: ["rm .*", "curl .*", "rm .*"], timeoutSec: 60 },
        },
      },
    };
    const parsed = parseWorkflow(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    expect(validateWorkflow(parsed.value).ok).toBe(true);
    const result = normalizeWorkflow(parsed.value);
    if (!result.ok) throw result.error;
    const startNode = result.value.graph.nodes.find((item) => item.id === "start");
    if (startNode?.type !== "start") throw new Error("missing start node");
    expect(startNode.polling?.probe).toMatchObject({
      type: "agent",
      permissions: {
        network: false,
        write: [],
        shellPolicy: { deny: ["curl .*", "rm .*"], timeoutSec: 60 },
      },
    });

    const bad = clone(raw) as Record<string, unknown>;
    const probe = (node(bad, "start").polling as Record<string, unknown>).probe as Record<
      string,
      unknown
    >;
    (probe.permissions as Record<string, unknown>).shellPolicy = { allow: ["("] };
    const report = validateWorkflow(parseOk(bad));
    expect(report.ok).toBe(false);
    expect(report.errors.map((item) => `${item.code} ${item.pointer}`)).toContain(
      "E_SHELL_POLICY /graph/nodes/0/polling/probe/permissions/shellPolicy/allow/0",
    );

    const disabled = clone(raw) as Record<string, unknown>;
    const probe2 = (node(disabled, "start").polling as Record<string, unknown>).probe as Record<
      string,
      unknown
    >;
    (probe2.permissions as Record<string, unknown>).shell = false;
    const disabledReport = validateWorkflow(parseOk(disabled));
    expect(disabledReport.ok).toBe(false);
    expect(disabledReport.errors.map((item) => `${item.code} ${item.pointer}`)).toContain(
      "E_SHELL_POLICY /graph/nodes/0/polling/probe/permissions/shellPolicy",
    );
  });
});
