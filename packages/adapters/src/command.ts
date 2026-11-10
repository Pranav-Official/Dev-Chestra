import { join } from "node:path";
import { DevChestraError } from "@devchestra/core";
import { wrapContainerInvocation } from "./container.js";
import { isGroupAlive, killTree, spawnIdentity } from "./identity.js";
import { boundTail, redacted, spawnFailure, waitSpawn } from "./spawn-util.js";
import type { CommandHooks, CommandRequest, CommandResult } from "./types.js";
import { spawnOwned, windowsCommand } from "./windows.js";

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
  let killCompletion: Promise<boolean> | undefined;
  let closed = false;
  const nativeShell = process.platform === "win32" && req.shell === true;
  const command = nativeShell
    ? {
        bin: join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(
            "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; " +
              req.cmd +
              "\nif (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
            "utf16le",
          ).toString("base64"),
        ],
      }
    : process.platform === "win32" && req.shell !== true
      ? windowsCommand(req.cmd, req.args ?? [], req.env, req.cwd)
      : { bin: req.cmd, args: req.args ?? [] };
  const args = [
    "-e",
    WRAPPER,
    "--",
    req.shell === true && !nativeShell ? "shell" : "argv",
    command.bin,
  ];
  if (req.shell !== true || nativeShell) args.push(...command.args);
  const container =
    req.container === undefined
      ? undefined
      : wrapContainerInvocation(
          {
            bin: req.shell ? "/bin/sh" : req.cmd,
            args: req.shell ? ["-c", req.cmd] : (req.args ?? []),
            cwd: req.cwd,
            env: req.env,
            files: [],
          },
          req.container,
        );
  const child = spawnOwned(
    process.execPath,
    container
      ? ["-e", WRAPPER, "--", "argv", container.invocation.bin, ...container.invocation.args]
      : args,
    {
      cwd: req.cwd,
      env: container?.invocation.env ?? req.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    await waitSpawn(child);
  } catch (error) {
    container?.cleanup();
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
    killCompletion = (async () => {
      const stopped = (await container?.stop()) ?? true;
      return (await killTree(pid, { graceMs: DEFAULT_GRACE })) && stopped;
    })();
  };
  const timer = setTimeout(() => kill("timeout"), Math.max(1, req.timeoutMs));
  const onAbort = (): void => kill("cancel");
  signal?.addEventListener("abort", onAbort, { once: true });
  // Abort may have arrived while awaiting the child spawn. The cast re-widens `aborted`, which the early check narrowed to false across the await.
  if ((signal as AbortSignal | undefined)?.aborted === true) onAbort();

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
    await killCompletion;
    await closePromise;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    container?.cleanup();
    throw error;
  }

  const { code, signal: closeSignal } = await closePromise;
  await killCompletion;
  closed = true;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (isGroupAlive(pid)) await killTree(pid, { graceMs: 0 }).catch(() => undefined);
  const containerStopped = (await container?.stop()) ?? true;
  container?.cleanup();
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
    groupStopped: !isGroupAlive(pid) && containerStopped,
  };
}
