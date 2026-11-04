import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionIdentity } from "@devchestra/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentGateway } from "../src/gateway.js";
import type { SubmissionPort } from "../src/ports.js";
import { resolveProgram, sanitizedPathDirs } from "../src/shell-exec.js";
import {
  type ExecScope,
  type ExecShellScope,
  ExecTokenRegistry,
  type ExecToolEvent,
} from "../src/tokens.js";
import { OutputValidator } from "../src/validate.js";

const PORT = 49_992;
const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;
const SAFE_PATH = "/usr/bin:/bin";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-shell-exec-"));
  dirs.push(dir);
  return realpathSync(dir);
}

const submissions: SubmissionPort = {
  submit: () => {
    throw new Error("submit must not be called by exec tests");
  },
} as unknown as SubmissionPort;

interface Rig {
  app: ReturnType<typeof createAgentGateway>;
  tokens: ExecTokenRegistry;
  events: ExecToolEvent[];
  cwd: string;
}

function makeRig(
  options: {
    policy?: ShellExecPolicy;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    execPlatform?: NodeJS.Platform;
    withShell?: boolean;
  } = {},
): Rig & { token: string; tokens: ExecTokenRegistry } {
  const cwd = options.cwd ?? workspace();
  const events: ExecToolEvent[] = [];
  const tokens = new ExecTokenRegistry();
  const shell: ExecShellScope = {
    policy: options.policy ?? {
      allow: ["^echo .+$", "^pwd$", "^env$", "^seq .+$", "^sleep .+$", "^ls .+$"],
    },
    cwd,
    env: options.env ?? { PATH: SAFE_PATH },
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
    onToolEvent: (event) => events.push(event),
  };
  const scope: ExecScope = {
    identity: { runId: "run-1", path: "research", attempt: 1, generation: 1 } as ExecutionIdentity,
    toolset: "agent",
    outputSchema: SCHEMA as unknown as Record<string, unknown>,
    outputSchemaHash: new OutputValidator().compile(SCHEMA).hash,
    validationLimit: 3,
    expiresAt: Date.now() + 600_000,
    ...(options.withShell === false ? {} : { shell }),
  };
  const token = tokens.issue(scope);
  const app = createAgentGateway({
    tokens,
    submissions,
    validator: new OutputValidator(),
    port: PORT,
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    ...(options.execPlatform === undefined ? {} : { execPlatform: options.execPlatform }),
  });
  return { app, tokens, events, cwd, token };
}

type ShellExecPolicy = NonNullable<ExecShellScope["policy"]>;

let seq = 0;
async function exec(
  rig: { app: Rig["app"] },
  token: string,
  args: Record<string, unknown>,
): Promise<Response> {
  seq += 1;
  return rig.app.request(`http://127.0.0.1:${PORT}/internal/agent/call`, {
    method: "POST",
    headers: {
      Host: `127.0.0.1:${PORT}`,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-DevChestra-Call-Id": `exec-${seq}`,
    },
    body: JSON.stringify({ name: "exec", arguments: args }),
  });
}

async function run(rig: Rig & { token: string }, command: string) {
  const res = await exec(rig, rig.token, { command });
  const body = (await res.json()) as { content: { text: string }[]; isError: boolean };
  return { status: res.status, text: body.content?.[0]?.text ?? "", isError: body.isError };
}

/** Live processes whose command line contains the marker (Linux /proc scan). */
function liveProcessesWith(marker: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(join("/proc", entry, "cmdline"), "utf8");
      if (cmdline.includes(marker) && !cmdline.includes("vitest")) hits.push(entry);
    } catch {
      // Process exited between readdir and read.
    }
  }
  return hits;
}

describe("exec tool advertisement", () => {
  it("advertises exec only for a token that carries a policy", async () => {
    const withPolicy = makeRig();
    const res = await withPolicy.app.request(`http://127.0.0.1:${PORT}/internal/agent/tools`, {
      headers: { Host: `127.0.0.1:${PORT}`, Authorization: `Bearer ${withPolicy.token}` },
    });
    const names = ((await res.json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["submit_result", "exec"]);

    const plain = makeRig({ withShell: false });
    const res2 = await plain.app.request(`http://127.0.0.1:${PORT}/internal/agent/tools`, {
      headers: { Host: `127.0.0.1:${PORT}`, Authorization: `Bearer ${plain.token}` },
    });
    const plainNames = ((await res2.json()) as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    expect(plainNames).toEqual(["submit_result"]);
  });

  it("describes the allow/deny rules and the stateless fixed-cwd model", async () => {
    const rig = makeRig({ policy: { allow: ["^rg .+$"], deny: ["\\s-o\\b"] } });
    const res = await rig.app.request(`http://127.0.0.1:${PORT}/internal/agent/tools`, {
      headers: { Host: `127.0.0.1:${PORT}`, Authorization: `Bearer ${rig.token}` },
    });
    const tool = (
      (await res.json()) as { tools: { name: string; description: string; inputSchema: unknown }[] }
    ).tools.find((t) => t.name === "exec");
    expect(tool?.description).toContain("^rg .+$");
    expect(tool?.description).toContain("\\s-o\\b");
    expect(tool?.description).toContain("stateless");
    expect(tool?.inputSchema).toMatchObject({ required: ["command"], additionalProperties: false });
  });
});

describe("exec allow and deny", () => {
  it("runs an allowed command and returns its stdout", async () => {
    const rig = makeRig();
    const result = await run(rig, "echo hello-world");
    expect(result.status).toBe(200);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("exited with code 0");
    expect(result.text).toContain("hello-world");
    expect(rig.events.map((e) => e.kind)).toEqual(["tool", "tool_result"]);
  });

  it("denies with the matched deny rule and the allowed patterns, and never runs it", async () => {
    const cwd = workspace();
    const rig = makeRig({ cwd, policy: { allow: ["^echo .+$"], deny: ["^touch\\b.*$"] } });
    const result = await run(rig, "touch marker");
    expect(result.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Command denied by shell policy");
    expect(result.text).toContain('deny rule "^touch\\b.*$"');
    expect(result.text).toContain("Allowed patterns: ^echo .+$");
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });

  it("an allowlist denies anything it does not match, naming the allowed patterns", async () => {
    const cwd = workspace();
    const rig = makeRig({ cwd, policy: { allow: ["^echo .+$"] } });
    const result = await run(rig, "touch marker");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("matched no allow rule");
    expect(result.text).toContain("Allowed patterns: ^echo .+$");
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });

  it("deny runs before allow, so a deny match wins over an allow match", async () => {
    const rig = makeRig({ policy: { allow: ["^echo .+$"], deny: ["^echo .*secret.*$"] } });
    const result = await run(rig, "echo secret-value");
    expect(result.isError).toBe(true);
    expect(result.text).toContain('deny rule "^echo .*secret.*$"');
  });

  it("reports a nonzero exit as a useful tool error, not a gateway failure", async () => {
    const rig = makeRig({ policy: { allow: ["^ls .+$"] } });
    const result = await run(rig, "ls /definitely-missing-path-xyz");
    expect(result.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("exited with code");
    expect(result.text).toContain("stderr");
  });

  it("reports an unknown program as a tool error", async () => {
    const rig = makeRig({ policy: { allow: ["^nosuchprogram-xyz .*$"] } });
    const result = await run(rig, "nosuchprogram-xyz arg");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found as an executable on the sanitized PATH");
  });
});

describe("exec metacharacters are rejected before anything runs", () => {
  const cases = [
    "echo a; echo b",
    "echo a && echo b",
    "echo a | cat",
    "echo a > out-file",
    "echo $(id)",
    "echo `id`",
    "echo $HOME",
    "echo *",
    "echo ~",
    "FOO=bar echo hi",
    "/bin/echo hi",
    "./echo hi",
  ];
  for (const command of cases) {
    it(`rejects ${JSON.stringify(command)}`, async () => {
      const cwd = workspace();
      const rig = makeRig({ cwd });
      const result = await run(rig, command);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/denied|must not|not allowed|unquoted|\$|\/|environment/);
      expect(existsSync(join(cwd, "out-file"))).toBe(false);
    });
  }
});

describe("exec execution environment", () => {
  it("pins the cwd to the token workspace", async () => {
    const cwd = workspace();
    const rig = makeRig({ cwd });
    const result = await run(rig, "pwd");
    expect(result.isError).toBe(false);
    expect(result.text).toContain(cwd);
  });

  it("passes only the allowlisted env and never leaks secrets from the process", async () => {
    process.env.DEVCHESTRA_SHELL_EXEC_SECRET = "super-secret-value-123";
    try {
      const rig = makeRig({ env: { PATH: SAFE_PATH, KEEP_ME: "visible" } });
      const result = await run(rig, "env");
      expect(result.text).toContain("KEEP_ME=visible");
      expect(result.text).not.toContain("super-secret-value-123");
      expect(result.text).not.toContain("DEVCHESTRA_SHELL_EXEC_SECRET");
    } finally {
      delete process.env.DEVCHESTRA_SHELL_EXEC_SECRET;
    }
  });

  it("never echoes the execution token into the tool result or events", async () => {
    const rig = makeRig({ policy: { allow: ["^echo .+$"] } });
    const result = await run(rig, "echo hi");
    expect(result.text).not.toContain(rig.token);
    expect(JSON.stringify(rig.events)).not.toContain(rig.token);
  });

  it("resolves argv0 only through absolute PATH entries and ignores relative ones", async () => {
    const bin = workspace();
    const tool = join(bin, "hello-tool");
    writeFileSync(tool, "#!/bin/sh\necho tool-ran\n");
    chmodSync(tool, 0o755);
    const cwd = workspace();
    writeFileSync(join(cwd, "rel-tool"), "#!/bin/sh\necho local-ran\n");
    chmodSync(join(cwd, "rel-tool"), 0o755);

    expect(sanitizedPathDirs(`relative:.:${bin}::/usr/bin`)).toEqual([bin, "/usr/bin"]);
    expect(resolveProgram("hello-tool", bin)).toBe(tool);
    expect(resolveProgram("rel-tool", ".")).toBeNull();
    expect(resolveProgram("rel-tool", "relative")).toBeNull();

    const rig = makeRig({
      cwd,
      env: { PATH: `.:${bin}` },
      policy: { allow: ["^hello-tool$", "^rel-tool$"] },
    });
    const ok = await run(rig, "hello-tool");
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("tool-ran");
    const rejected = await run(rig, "rel-tool");
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("not found as an executable");
  });

  it("refuses to run on win32 with a clear tool error", async () => {
    const cwd = workspace();
    const rig = makeRig({ cwd, execPlatform: "win32" });
    const result = await run(rig, "echo hi");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("POSIX-only");
  });
});

describe("exec deadlines and output caps", () => {
  it("kills a command at the policy timeout and leaves no process behind", async () => {
    const marker = "sleep 4711";
    const rig = makeRig({ timeoutMs: 1_000, policy: { allow: ["^sleep .+$"] } });
    const started = Date.now();
    const result = await run(rig, marker);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("timed out");
    expect(liveProcessesWith("sleep 4711")).toEqual([]);
  });

  it("truncates stdout to the policy cap and says so", async () => {
    const rig = makeRig({ maxOutputBytes: 32, policy: { allow: ["^seq .+$"] } });
    const result = await run(rig, "seq 1 2000");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("[truncated: kept last 32 of");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(1024);
  });
});

describe("exec argument and token strictness", () => {
  it("rejects a policy or cwd smuggled in tool arguments", async () => {
    const cwd = workspace();
    const rig = makeRig({ cwd });
    for (const args of [
      { command: "echo hi", cwd: "/" },
      { command: "echo hi", policy: { allow: ["^echo .+$"] } },
      { command: "echo hi", env: { PATH: "/usr/bin" } },
      { command: 3 },
      {},
    ]) {
      const res = await exec(rig, rig.token, args);
      expect(res.status).toBe(400);
    }
  });

  it("forbids exec for a token without a shell policy", async () => {
    const rig = makeRig({ withShell: false });
    const res = await exec(rig, rig.token, { command: "echo hi" });
    expect(res.status).toBe(403);
  });

  it("uses the frozen token policy, not any policy sent by the caller", async () => {
    const rig = makeRig({ policy: { allow: ["^echo .+$"] } });
    const res = await exec(rig, rig.token, { command: "pwd" });
    const body = (await res.json()) as { isError: boolean; content: { text: string }[] };
    expect(body.isError).toBe(true);
    expect(body.content[0]?.text).toContain("matched no allow rule");
  });
});

describe("exec transcript events", () => {
  it("records a tool call and result for an allowed run and a denied run", async () => {
    const rig = makeRig({ policy: { allow: ["^echo .+$"] } });
    await run(rig, "echo ok");
    await run(rig, "pwd");
    expect(rig.events).toEqual([
      expect.objectContaining({ kind: "tool", text: "exec echo ok" }),
      expect.objectContaining({ kind: "tool_result" }),
      expect.objectContaining({ kind: "tool", text: "exec pwd" }),
      expect.objectContaining({ kind: "tool_result", text: expect.stringContaining("denied") }),
    ]);
  });
});

describe("exec resume", () => {
  it("re-mints from the frozen policy with the current workspace", async () => {
    const first = workspace();
    const rig = makeRig({ cwd: first, policy: { allow: ["^pwd$"] } });
    expect((await run(rig, "pwd")).text).toContain(first);

    rig.tokens.clear();
    const second = workspace();
    const scope: ExecScope = {
      identity: {
        runId: "run-1",
        path: "research",
        attempt: 2,
        generation: 1,
      } as ExecutionIdentity,
      toolset: "agent",
      outputSchema: SCHEMA as unknown as Record<string, unknown>,
      outputSchemaHash: new OutputValidator().compile(SCHEMA).hash,
      validationLimit: 3,
      expiresAt: Date.now() + 600_000,
      shell: {
        policy: { allow: ["^pwd$"] },
        cwd: second,
        env: { PATH: SAFE_PATH },
        timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024,
      },
    };
    const token = rig.tokens.issue(scope);
    const resumed = await run({ ...rig, token }, "pwd");
    expect(resumed.text).toContain(second);
    expect(resumed.text).not.toContain(first);

    const stale = await exec(rig, rig.token, { command: "pwd" });
    expect(stale.status).toBe(401);
  });
});
