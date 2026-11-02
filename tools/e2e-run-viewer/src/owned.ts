import { type ChildProcess, spawn } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { killTree, matchesProcess, readProcessIdentity } from "@devchestra/adapters";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export interface SpawnedAgent {
  pid: number;
  pidStart: string;
  binary: string;
}

export interface ServerMeta {
  version: string;
  pid: number;
  pidStart: string;
  port: number;
  token: string;
  instanceId: string;
  startedAt: number;
}

export interface OwnedServer {
  readonly child: ChildProcess;
  readonly meta: ServerMeta;
  readonly recorded: SpawnedAgent;
  readonly stdoutLines: string[];
  readonly stderr: () => string;
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

export interface StartServerOptions {
  cli: string;
  dataDir: string;
  cwd: string;
  fakeScript?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

async function readMeta(dataDir: string): Promise<ServerMeta | null> {
  const path = join(dataDir, "server.json");
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink()) throw new Error("server.json must not be a symlink");
  if ((entry.mode & 0o777) !== 0o600) {
    throw new Error(`server.json must be mode 0600, got 0${(entry.mode & 0o777).toString(8)}`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("server.json is not an object");
  const value = parsed as Record<string, unknown>;
  for (const key of ["version", "pidStart", "token", "instanceId"]) {
    if (typeof value[key] !== "string") throw new Error(`server.json.${key} must be a string`);
  }
  for (const key of ["pid", "port", "startedAt"]) {
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key])) {
      throw new Error(`server.json.${key} must be an integer`);
    }
  }
  return {
    version: value.version as string,
    pid: value.pid as number,
    pidStart: value.pidStart as string,
    port: value.port as number,
    token: value.token as string,
    instanceId: value.instanceId as string,
    startedAt: value.startedAt as number,
  };
}

export async function startServer(options: StartServerOptions): Promise<OwnedServer> {
  const args = [
    options.cli,
    "start",
    "--foreground",
    "--data-dir",
    options.dataDir,
    "--port",
    "0",
    "--no-open",
  ];
  if (options.fakeScript !== undefined) args.push("--fake-script", options.fakeScript);
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    detached: true,
    env: {
      ...process.env,
      ...(options.fakeScript !== undefined ? { DEVCHESTRA_ALLOW_FAKE: "1" } : {}),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("devchestra start did not produce a pid");
  const pid = child.pid;
  let recorded: SpawnedAgent | null = null;
  for (let attempt = 0; attempt < 100 && recorded === null; attempt += 1) {
    const identity = await readProcessIdentity(pid);
    if (identity !== null) {
      recorded = { pid: identity.pid, pidStart: identity.pidStart, binary: identity.binary };
    } else {
      await sleep(20);
    }
  }
  if (recorded === null) {
    child.kill("SIGKILL");
    throw new Error("Could not capture devchestra start process identity");
  }

  const stdoutLines: string[] = [];
  let stderr = "";
  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line !== "") stdoutLines.push(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });

  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let meta: ServerMeta | null = null;
  while (meta === null) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`devchestra start exited before readiness. stderr: ${stderr}`);
    }
    meta = await readMeta(options.dataDir);
    if (meta === null) {
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error("Timed out waiting for server.json");
      }
      await sleep(25);
    }
  }
  if (meta.pidStart !== recorded.pidStart || meta.pid !== recorded.pid) {
    throw new Error("server.json identity does not match the launched process");
  }
  const ready = stdoutLines.find((line) => line.includes('"devchestra.ready"'));
  if (ready !== undefined) {
    const record = JSON.parse(ready) as Record<string, unknown>;
    if (record.type !== "devchestra.ready") throw new Error("unexpected ready record");
    if (record.token !== undefined) throw new Error("devchestra.ready must not contain a token");
    if (record.port !== meta.port || record.pid !== meta.pid) {
      throw new Error("devchestra.ready disagrees with server.json");
    }
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (await matchesProcess(recorded)) {
      try {
        process.kill(-recorded.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    const graceful = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!graceful && (await matchesProcess(recorded))) {
      await killTree(recorded.pid, { graceMs: 0 });
      await Promise.race([exited, sleep(2_000)]);
    }
    if (await matchesProcess(recorded)) {
      throw new Error("owned devchestra process survived graceful stop");
    }
  };

  return {
    child,
    meta,
    recorded,
    stdoutLines,
    stderr: () => stderr,
    baseUrl: `http://127.0.0.1:${String(meta.port)}`,
    stop,
  };
}

export async function shutdownOwned(input: {
  server: OwnedServer;
  agents: readonly SpawnedAgent[];
  sentinel: ChildProcess;
  keep: boolean;
  dataDir: string;
}): Promise<void> {
  await input.server.stop();
  for (const agent of input.agents) {
    if (await matchesProcess(agent)) {
      await killTree(agent.pid, { graceMs: 500 });
    }
    if (await matchesProcess(agent)) {
      throw new Error(`owned agent ${String(agent.pid)} survived cleanup`);
    }
  }
  if (await matchesProcess(input.server.recorded)) {
    throw new Error("owned devchestra process survived cleanup");
  }
  if (input.sentinel.exitCode !== null || input.sentinel.signalCode !== null) {
    throw new Error("unrelated sentinel died during cleanup");
  }
  input.sentinel.kill("SIGKILL");
  if (!input.keep) await rm(input.dataDir, { recursive: true, force: true });
}

export function startSentinel(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => undefined, 120000)"], {
    stdio: "ignore",
  });
}

export function collectAgent(event: { type?: string; payload?: unknown }): SpawnedAgent | null {
  if (event.type !== "node.process.spawned") return null;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload === undefined) return null;
  const pid = payload.pid;
  const pidStart = payload.pidStart;
  const binary = payload.binary;
  if (typeof pid !== "number" || typeof pidStart !== "string" || typeof binary !== "string") {
    return null;
  }
  return { pid, pidStart, binary };
}
