import { readFileSync } from "node:fs";
import { processAlive, processIdentity } from "./lock.js";
import { clearServerMetadata, readServerMetadata, type ServerMetadata } from "./server-metadata.js";

export type ServerState = "running" | "stopped" | "stale" | "unsafe" | "invalid";

export interface ServerStatus {
  state: ServerState;
  dataDir: string;
  /** Why the state is not `running`/`stopped`, in plain words. */
  reason?: string;
  pid?: number;
  port?: number;
  url?: string;
  version?: string;
  startedAt?: number;
  uptimeMs?: number;
  /** Active runs reported by the server; null when the server did not answer. */
  activeRuns?: number | null;
  projects?: number | null;
}

export interface ServerControlDeps {
  now?: () => number;
  fetch?: typeof fetch;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** An exited process whose parent has not reaped it yet still answers `kill(pid, 0)`. */
function isZombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return close !== -1 && stat[close + 2] === "Z";
  } catch {
    return false;
  }
}

/** True only for the process that wrote the metadata, not a recycled pid. */
function isSameProcess(meta: ServerMetadata): boolean {
  return (
    processAlive(meta.pid) && !isZombie(meta.pid) && processIdentity(meta.pid) === meta.pidStart
  );
}

async function askServer(
  meta: ServerMetadata,
  deps: ServerControlDeps,
): Promise<{ activeRuns: number | null; projects: number | null }> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(`http://127.0.0.1:${meta.port}/api/bootstrap`, {
      headers: { "x-devchestra-token": meta.token },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return { activeRuns: null, projects: null };
    const body = (await response.json()) as {
      counts?: { activeRuns?: unknown };
      projects?: unknown;
    };
    const active = body.counts?.activeRuns;
    return {
      activeRuns: typeof active === "number" ? active : null,
      projects: Array.isArray(body.projects) ? body.projects.length : null,
    };
  } catch {
    return { activeRuns: null, projects: null };
  }
}

export async function serverStatus(
  dataDir: string,
  deps: ServerControlDeps = {},
): Promise<ServerStatus> {
  const now = deps.now ?? Date.now;
  const read = await readServerMetadata(dataDir);
  if (read.status === "missing") return { state: "stopped", dataDir };
  if (read.status === "invalid") return { state: "invalid", dataDir, reason: read.reason };
  if (read.status === "unsafe") return { state: "unsafe", dataDir, reason: read.reason };
  const meta = read.value;
  const base = {
    dataDir,
    pid: meta.pid,
    port: meta.port,
    url: `http://127.0.0.1:${meta.port}/`,
    version: meta.version,
    startedAt: meta.startedAt,
  };
  if (!isSameProcess(meta)) {
    return {
      state: "stale",
      ...base,
      reason: "the recorded server process is gone (crash or reboot); the record is left over",
    };
  }
  const asked = await askServer(meta, deps);
  return {
    state: "running",
    ...base,
    uptimeMs: Math.max(0, now() - meta.startedAt),
    ...asked,
  };
}

export interface StopOptions {
  force: boolean;
  timeoutMs: number;
}

export type StopOutcome =
  | { result: "stopped"; status: ServerStatus; killed: boolean }
  | { result: "not-running"; status: ServerStatus; cleanedStaleRecord: boolean }
  | { result: "refused"; status: ServerStatus; reason: string }
  | { result: "failed"; status: ServerStatus; reason: string };

export async function stopServer(
  dataDir: string,
  options: StopOptions,
  deps: ServerControlDeps = {},
): Promise<StopOutcome> {
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? sleepDefault;
  const status = await serverStatus(dataDir, deps);

  if (status.state === "stopped") {
    return { result: "not-running", status, cleanedStaleRecord: false };
  }
  if (status.state === "stale") {
    await clearServerMetadata(dataDir);
    return { result: "not-running", status, cleanedStaleRecord: true };
  }
  if (status.state !== "running" || status.pid === undefined) {
    return {
      result: "failed",
      status,
      reason: `${status.reason ?? "server record is unusable"}; refusing to signal anything`,
    };
  }
  if (!options.force && (status.activeRuns ?? 0) > 0) {
    return {
      result: "refused",
      status,
      reason: `${status.activeRuns} run(s) are still active. Stopping now interrupts them; pass --force to stop anyway.`,
    };
  }

  const pid = status.pid;
  const meta = await readServerMetadata(dataDir);
  const pidStart = meta.status === "valid" ? meta.value.pidStart : null;
  const gone = (): boolean =>
    !processAlive(pid) || isZombie(pid) || (pidStart !== null && processIdentity(pid) !== pidStart);

  try {
    kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      return { result: "failed", status, reason: `could not signal the server: ${String(error)}` };
    }
  }

  const deadline = Date.now() + options.timeoutMs;
  while (!gone() && Date.now() < deadline) await sleep(100);

  let killed = false;
  if (!gone()) {
    if (!options.force) {
      return {
        result: "failed",
        status,
        reason: `the server did not exit within ${Math.round(options.timeoutMs / 1000)}s (it may still be finishing runs). Wait, or pass --force to kill it.`,
      };
    }
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    killed = true;
    const killDeadline = Date.now() + 3000;
    while (!gone() && Date.now() < killDeadline) await sleep(50);
    if (!gone()) {
      return { result: "failed", status, reason: "the server survived SIGKILL" };
    }
  }

  // A clean shutdown removes its own record; a killed one cannot.
  const after = await readServerMetadata(dataDir);
  if (after.status === "valid" && after.value.pid === pid) await clearServerMetadata(dataDir);
  return { result: "stopped", status, killed };
}
