import { spawn } from "node:child_process";
import { DevChestraError } from "@devchestra/core";
import { isGroupAlive, killTree, spawnIdentity } from "./identity.js";
import { boundTail, redacted, spawnFailure, waitSpawn } from "./spawn-util.js";
import type { CommandHooks, CommandRequest, CommandResult } from "./types.js";

const DEFAULT_GRACE = 5_000;
const DEFAULT_MAX_LINE = 8 * 1024 * 1024;
const DEFAULT_STDERR = 256 * 1024;

const WRAPPER = String.raw`
const { spawn } = require("node:child_process");
const mode = process.argv[1];
const cmd = process.argv[2];
const args = process.argv.slice(3);
if (!cmd) { process.stderr.write("devchestra-wrapper: missing command\n"); process.exit(64); }
let buf = Buffer.alloc(0);
let started = false;
let child = null;
function start() {
  started = true;
  const leftover = buf;
  buf = Buffer.alloc(0);
  if (mode === "shell") {
    child = spawn(cmd, [], { shell: true, stdio: ["pipe", "inherit", "inherit"], env: process.env });
  } else {
    child = spawn(cmd, args, { stdio: ["pipe", "inherit", "inherit"], env: process.env });
  }
  if (leftover.length > 0) child.stdin.write(leftover);
  process.stdin.removeListener("data", onData);
  process.stdin.on("data", (chunk) => { if (!child.stdin.destroyed) child.stdin.write(chunk); });
  process.stdin.on("end", () => { if (!child.stdin.destroyed) child.stdin.end(); });
  child.on("error", (error) => { process.stderr.write("devchestra-wrapper: " + error.message + "\n"); process.exit(127); });
  child.on("exit", (code) => { process.exit(code === null ? 1 : code); });
}
function onData(chunk) {
  if (started) return;
  buf = Buffer.concat([buf, chunk]);
  const index = buf.indexOf(10);
  if (index < 0) return;
  const line = buf.subarray(0, index).toString("utf8").trim();
  buf = buf.subarray(index + 1);
  if (line !== "GO") { process.stderr.write("devchestra-wrapper: bad handshake\n"); process.exit(70); }
  start();
}
process.stdin.on("data", onData);
process.stdin.on("end", () => { if (!started) process.exit(70); });
process.stdin.resume();
`;

export async function runCommand(
  req: CommandRequest,
  hooks: CommandHooks,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted === true)
    throw new DevChestraError("E_CANCELLED", "Command cancelled before spawn");
  if (req.shell === true && (req.args?.length ?? 0) > 0) {
    throw new DevChestraError("E_VALIDATION", "Shell commands must put arguments in cmd");
  }
  const startedAt = Date.now();
  const maxOut = req.maxStdoutBytes ?? DEFAULT_MAX_LINE;
  const maxErr = req.maxStderrBytes ?? DEFAULT_STDERR;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdout = "";
  let stderr = "";
  let killedBy: CommandResult["killedBy"] = null;
  let killStarted = false;
  let closed = false;
  const args = ["-e", WRAPPER, "--", req.shell === true ? "shell" : "argv", req.cmd];
  if (req.shell !== true) args.push(...(req.args ?? []));
  const child = spawn(process.execPath, args, {
    cwd: req.cwd,
    env: req.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await waitSpawn(child);
  } catch (error) {
    throw spawnFailure(error);
  }
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    throw new DevChestraError("E_INTERNAL", "Spawned command wrapper has no pid");
  }
  child.on("error", () => undefined);

  const kill = (reason: "timeout" | "cancel"): void => {
    if (killedBy === null) killedBy = reason;
    if (killStarted) return;
    killStarted = true;
    void killTree(pid, { graceMs: DEFAULT_GRACE });
  };
  const timer = setTimeout(() => kill("timeout"), Math.max(1, req.timeoutMs));
  const onAbort = (): void => kill("cancel");
  signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    const text = redacted(hooks, chunk.toString("utf8"));
    stdout = boundTail(stdout + text, maxOut);
    child.stdout?.pause();
    Promise.resolve()
      .then(() => hooks.onStdout?.(text))
      .catch(() => undefined)
      .finally(() => {
        if (!closed) child.stdout?.resume();
      });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    const text = redacted(hooks, chunk.toString("utf8"));
    stderr = boundTail(stderr + text, maxErr);
    hooks.onStderr?.(text);
  });

  const closePromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, sig) =>
      resolve({ code, signal: sig === null ? null : String(sig) }),
    );
  });

  try {
    if (hooks.onSpawn !== undefined) {
      await hooks.onSpawn(await spawnIdentity(pid, req.cwd, hooks.generation ?? 1));
    }
    if (!killStarted) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.write("GO\n");
      if (req.stdin !== undefined) child.stdin?.write(req.stdin);
      child.stdin?.end();
    }
  } catch (error) {
    kill("cancel");
    throw error;
  }

  const { code, signal: closeSignal } = await closePromise;
  closed = true;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (isGroupAlive(pid)) await killTree(pid, { graceMs: 0 }).catch(() => undefined);
  return {
    exitCode: code,
    signal: closeSignal,
    killedBy,
    durationMs: Date.now() - startedAt,
    pid,
    stdout,
    stderr,
    stdoutBytes,
    stderrBytes,
    groupStopped: !isGroupAlive(pid),
  };
}
