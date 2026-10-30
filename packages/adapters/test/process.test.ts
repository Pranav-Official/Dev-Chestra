import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdapterEvent,
  createAdapter,
  type Invocation,
  killOrphan,
  matchesProcess,
  readProcessIdentity,
  runAgent,
  runCommand,
  type SpawnIdentity,
} from "../src/index.js";
import { TOKEN } from "./helpers.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() ?? "", { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "devchestra-adapters-"));
  dirs.push(dir);
  return dir;
}

async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.cjs`);
  await writeFile(path, body, "utf8");
  return path;
}

function invocation(
  path: string,
  dir: string,
  env: Record<string, string>,
  stdin?: string,
): Invocation {
  return {
    bin: process.execPath,
    args: [path],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...env },
    files: [],
    ...(stdin === undefined ? {} : { stdin }),
  };
}

function parser(onLine?: (line: string) => AdapterEvent[]): {
  feed: (chunk: Buffer) => AdapterEvent[];
  end: () => AdapterEvent[];
} {
  return {
    feed: (chunk) => onLine?.(chunk.toString("utf8")) ?? [],
    end: () => [],
  };
}

function running(pid: number): boolean {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(")") + 2).trim()[0];
    return state !== "Z";
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("runAgent", () => {
  it("awaits onSpawn before releasing stdin and records a canonical identity", async () => {
    const dir = await workspace();
    const marker = join(dir, "marker");
    const path = await script(
      dir,
      "stdin",
      `const fs = require("node:fs");
const marker = process.env.MARKER;
const chunks = [];
process.stdin.on("data", (chunk) => { chunks.push(chunk); fs.writeFileSync(marker + ".stdin", Buffer.concat(chunks)); });
process.stdin.on("end", () => { fs.writeFileSync(marker + ".done", "x"); process.exit(0); });
setTimeout(() => process.exit(9), 5000);`,
    );
    let spawn: SpawnIdentity | undefined;
    const result = await runAgent(
      invocation(path, dir, { MARKER: marker }, "hello-prompt"),
      {
        onSpawn: async (identity) => {
          spawn = identity;
          expect(running(identity.pid)).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(() => readFileSync(`${marker}.stdin`)).toThrow();
        },
      },
      new AbortController().signal,
      { timeoutMs: 4_000, parser: parser(), graceMs: 200 },
    );
    expect(result.code).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(result.pid).toBe(spawn?.pid);
    expect(spawn?.pidStart).toMatch(/^(linux:|darwin:|windows:)/);
    expect(spawn?.binary).toContain(process.platform === "win32" ? "windows-process" : "node");
    expect(spawn?.cwd).toBe(dir);
    expect(await readFile(`${marker}.stdin`, "utf8")).toBe("hello-prompt");
    expect(await readFile(`${marker}.done`, "utf8")).toBe("x");
  });

  it("closes stdin immediately when no prompt is supplied", async () => {
    const dir = await workspace();
    const out = join(dir, "closed");
    const path = await script(
      dir,
      "closed",
      `const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => { fs.writeFileSync(process.env.OUT, "closed"); process.exit(0); });
setTimeout(() => process.exit(9), 3000);`,
    );
    const result = await runAgent(
      invocation(path, dir, { OUT: out }),
      {},
      new AbortController().signal,
      { timeoutMs: 3_000, parser: parser(), graceMs: 200 },
    );
    expect(result.code).toBe(0);
    expect(await readFile(out, "utf8")).toBe("closed");
  });

  it("SIGKILLs a SIGTERM-ignoring tree, including grandchildren", async () => {
    const dir = await workspace();
    const pids = join(dir, "pids.json");
    const path = await script(
      dir,
      "tree",
      `const fs = require("node:fs");
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.PIDS, JSON.stringify({ parent: process.pid, child: child.pid }));
process.stdin.resume();
setInterval(() => {}, 1000);`,
    );
    const result = await runAgent(
      invocation(path, dir, { PIDS: pids }),
      {},
      new AbortController().signal,
      { timeoutMs: 600, parser: parser(), graceMs: 100 },
    );
    expect(result.killedBy).toBe("timeout");
    const recorded = await readJson<{ parent: number; child: number }>(pids);
    expect(await waitFor(() => !running(recorded.parent))).toBe(true);
    expect(await waitFor(() => !running(recorded.child))).toBe(true);
  });

  it("cancels the process group on abort", async () => {
    const dir = await workspace();
    const path = await script(dir, "wait", "process.stdin.resume(); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await runAgent(invocation(path, dir, {}), {}, controller.signal, {
      timeoutMs: 5_000,
      parser: parser(),
      graceMs: 100,
    });
    expect(result.killedBy).toBe("cancel");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("bounds stderr and oversized lines without losing later lines", async () => {
    const dir = await workspace();
    const path = await script(
      dir,
      "noise",
      `process.stderr.write("E".repeat(10000));
process.stdout.write("X".repeat(200000));
process.stdout.write("\\n");
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
process.stdin.resume();`,
    );
    const events: AdapterEvent[] = [];
    const transcript: string[] = [];
    const result = await runAgent(
      invocation(path, dir, {}),
      {
        onEvent: (event) => {
          events.push(event);
        },
        onTranscript: (entry) => {
          transcript.push(entry.text);
        },
      },
      new AbortController().signal,
      {
        timeoutMs: 4_000,
        parser: parser(),
        graceMs: 200,
        maxLineBytes: 1024,
        maxStderrBytes: 512,
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderrBytes).toBeGreaterThan(9_000);
    expect(result.tail.stderr.length).toBeLessThanOrEqual(512);
    expect(result.stdoutBytes).toBeGreaterThan(200_000);
    expect(result.tail.stdout.length).toBeLessThanOrEqual(64 * 1024);
    const raw = events.filter((event) => event.t === "raw");
    expect(raw).toHaveLength(1);
    expect(raw[0]?.t === "raw" ? raw[0].line : "").toContain("truncated");
    expect(transcript.some((text) => text.includes("truncated"))).toBe(true);
    expect(transcript.some((text) => text.startsWith("E"))).toBe(true);
    expect(transcript.every((text) => Buffer.byteLength(text) <= 16 * 1024 + 100)).toBe(true);
  });

  it("redacts transcript and stderr through the supplied guard", async () => {
    const dir = await workspace();
    const path = await script(
      dir,
      "secret",
      `process.stderr.write("token=" + ${JSON.stringify(TOKEN)} + "\\n");
process.stdout.write(JSON.stringify({ type: "devchestra-fake", event: "error", sessionId: "s", message: ${JSON.stringify(TOKEN)} }) + "\\n");`,
    );
    const transcript: string[] = [];
    const result = await runAgent(
      invocation(path, dir, {}),
      {
        redact: (text) => text.split(TOKEN).join("[redacted]"),
        onTranscript: (entry) => {
          transcript.push(entry.text);
        },
      },
      new AbortController().signal,
      { timeoutMs: 3_000, parser: createAdapter("fake").parser(), graceMs: 200 },
    );
    expect(result.code).toBe(0);
    expect(transcript.join("\n")).not.toContain(TOKEN);
    expect(result.tail.stderr).not.toContain(TOKEN);
  });

  it("raises E_CLI_MISSING for a missing binary", async () => {
    const dir = await workspace();
    await expect(
      runAgent(
        { bin: join(dir, "does-not-exist"), args: [], cwd: dir, env: {}, files: [] },
        {},
        new AbortController().signal,
        { timeoutMs: 1_000, parser: parser() },
      ),
    ).rejects.toMatchObject({ code: "E_CLI_MISSING" });
  });

  it("emits a repeat watchdog for repeated identical tool calls", async () => {
    const dir = await workspace();
    const path = await script(
      dir,
      "repeat",
      `for (let i = 0; i < 9; i += 1) process.stdout.write(i + "\\n");`,
    );
    const watchdogs: string[] = [];
    await runAgent(
      invocation(path, dir, {}),
      {
        onWatchdog: (kind) => {
          watchdogs.push(kind);
        },
      },
      new AbortController().signal,
      {
        timeoutMs: 3_000,
        parser: parser(() => [
          { t: "tool_call", id: "same", name: "submit_result", input: { a: 1 } },
        ]),
        graceMs: 200,
      },
    );
    expect(watchdogs).toContain("repeat");
  });

  it("reports silence through the watchdog without killing", async () => {
    const dir = await workspace();
    const path = await script(dir, "silence", "setTimeout(() => process.exit(0), 500);");
    const watchdogs: string[] = [];
    const result = await runAgent(
      invocation(path, dir, {}),
      {
        onWatchdog: (kind) => {
          watchdogs.push(kind);
        },
      },
      new AbortController().signal,
      { timeoutMs: 3_000, silenceMs: 100, parser: parser(), graceMs: 200 },
    );
    expect(result.code).toBe(0);
    expect(watchdogs).toContain("silence");
  });
});

describe("runCommand", () => {
  it("gates command execution behind onSpawn", async () => {
    const dir = await workspace();
    const marker = join(dir, "started");
    const path = await script(
      dir,
      "immediate",
      `const fs = require("node:fs"); fs.writeFileSync(process.env.MARKER, "started"); process.exit(0);`,
    );
    let seen = false;
    const result = await runCommand(
      {
        cmd: process.execPath,
        args: [path],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", MARKER: marker },
        timeoutMs: 3_000,
      },
      {
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(() => readFileSync(marker)).toThrow();
          seen = true;
        },
      },
    );
    expect(seen).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(await readFile(marker, "utf8")).toBe("started");
  });

  it("passes stdin after the handshake and bounds output", async () => {
    const dir = await workspace();
    const path = await script(
      dir,
      "echo",
      `let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => { process.stdout.write(data); process.stderr.write("E".repeat(10000)); process.exit(0); });`,
    );
    const result = await runCommand(
      {
        cmd: process.execPath,
        args: [path],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        stdin: "hello-command",
        timeoutMs: 3_000,
        maxStdoutBytes: 256,
        maxStderrBytes: 128,
      },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-command");
    expect(result.stderrBytes).toBeGreaterThan(9_000);
    expect(result.stderr.length).toBeLessThanOrEqual(128);
  });

  it("times out the wrapper group", async () => {
    const dir = await workspace();
    const path = await script(dir, "hang", "process.stdin.resume(); setInterval(() => {}, 1000);");
    const result = await runCommand(
      {
        cmd: process.execPath,
        args: [path],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 500,
      },
      {},
    );
    expect(result.killedBy).toBe("timeout");
    expect(await waitFor(() => !running(result.pid))).toBe(true);
  });
});

describe("orphan identity", () => {
  it("refuses a pid when pidStart does not match", async () => {
    const identity = await readProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    if (identity === null) return;
    const reused = { ...identity, pidStart: `${identity.pidStart}-reused` };
    expect(await matchesProcess(identity)).toBe(true);
    expect(await matchesProcess(reused)).toBe(false);
    await expect(killOrphan(reused)).resolves.toEqual({ matched: false, killed: false });
  });

  it("refuses a bare pid with no start evidence", async () => {
    expect(await matchesProcess({ pid: process.pid, pidStart: "" })).toBe(false);
    expect(await matchesProcess({ pid: 0, pidStart: "" })).toBe(false);
  });
});

describe("materializeInvocation", () => {
  it("writes generated files owner-only", async () => {
    const dir = await workspace();
    const { materializeInvocation } = await import("../src/index.js");
    await materializeInvocation({
      bin: "/bin/true",
      args: [],
      cwd: dir,
      env: {},
      files: [{ path: join(dir, "exec", "mcp.json"), content: "{}\n" }],
    });
    const { stat } = await import("node:fs/promises");
    if (process.platform === "win32") {
      const { isWindowsPrivatePath } = await import("../src/index.js");
      expect(isWindowsPrivatePath(join(dir, "exec", "mcp.json"))).toBe(true);
      expect(isWindowsPrivatePath(join(dir, "exec"))).toBe(true);
    } else {
      expect((await stat(join(dir, "exec", "mcp.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "exec"))).mode & 0o777).toBe(0o700);
    }
  });

  it("links canonical files instead of copying them", async () => {
    const dir = await workspace();
    const { materializeInvocation } = await import("../src/index.js");
    const { readlink, readFile, writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "canonical.json"), '{"a":1}\n');
    const inv = {
      bin: "/bin/true",
      args: [],
      cwd: dir,
      env: {},
      files: [{ path: join(dir, "exec", "linked.json"), symlink: join(dir, "canonical.json") }],
    };
    await materializeInvocation(inv);
    // Repeat materialization replaces the previous link instead of failing.
    await materializeInvocation(inv);
    if (process.platform !== "win32")
      expect(await readlink(join(dir, "exec", "linked.json"))).toBe(join(dir, "canonical.json"));
    expect(await readFile(join(dir, "exec", "linked.json"), "utf8")).toBe('{"a":1}\n');
  });
});

describe("killTree semantics", () => {
  it("does not report a kill when the group is already gone", async () => {
    const { killTree } = await import("../src/index.js");
    expect(await killTree(999_999_999)).toBe(false);
  });

  it("returns false when SIGKILL cannot stop the injected group", async () => {
    const { killTreeWith } = await import("../src/identity.js");
    expect(
      await killTreeWith(42, 0, {
        isAlive: () => true,
        signal: async () => undefined,
        sleep: async () => undefined,
      }),
    ).toBe(false);
  });

  it("returns true when the injected group dies after SIGKILL", async () => {
    const { killTreeWith } = await import("../src/identity.js");
    let alive = true;
    expect(
      await killTreeWith(42, 0, {
        isAlive: () => alive,
        signal: async (_pid, signal) => {
          if (signal === "SIGKILL") alive = false;
        },
        sleep: async () => undefined,
      }),
    ).toBe(true);
  });
});
