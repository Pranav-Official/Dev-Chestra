import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { DevChestraError } from "@devchestra/core";
import type { ProcessIdentity, SpawnIdentity } from "./types.js";

const DEFAULT_GRACE = 5_000;
const IDENTITY_ATTEMPTS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBinary(value: string): string {
  const trimmed = value.trim().replace(/ \(deleted\)$/, "");
  return trimmed === "" ? "unknown" : trimmed;
}

let cachedBootId: string | null | undefined;

async function bootId(): Promise<string | null> {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    cachedBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

function ps(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      args,
      { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => {
        resolve(error === null ? stdout.trim() : "");
      },
    );
  });
}

async function linuxIdentity(pid: number): Promise<ProcessIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  if (ticks === undefined || !/^\d+$/.test(ticks)) return null;
  const id = await bootId();
  if (id === null) return null;
  let binary = "";
  try {
    binary = await readlink(`/proc/${pid}/exe`);
  } catch {
    binary = raw.slice(1, close);
  }
  return { pid, pidStart: `linux:${id}:${ticks}`, binary: normalizeBinary(binary) };
}

async function darwinIdentity(pid: number): Promise<ProcessIdentity | null> {
  const [lstart, comm] = await Promise.all([
    ps(["-o", "lstart=", "-p", String(pid)]),
    ps(["-o", "comm=", "-p", String(pid)]),
  ]);
  if (lstart === "") return null;
  return {
    pid,
    pidStart: `darwin:${lstart.replace(/\s+/g, " ").trim()}`,
    binary: normalizeBinary(comm),
  };
}

/** Query a live process identity. A pid by itself is never identity evidence. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") return linuxIdentity(pid);
  if (process.platform === "darwin") return darwinIdentity(pid);
  return null;
}

async function identityWithRetry(pid: number): Promise<ProcessIdentity | null> {
  for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt += 1) {
    const id = await readProcessIdentity(pid);
    if (id !== null) return id;
    await sleep(10);
  }
  return null;
}

/** True only when pid, canonical pidStart and (when supplied) binary all match. */
export async function matchesProcess(
  recorded: Pick<ProcessIdentity, "pid" | "pidStart"> & { binary?: string },
): Promise<boolean> {
  if (typeof recorded.pidStart !== "string" || recorded.pidStart === "") return false;
  const current = await readProcessIdentity(recorded.pid);
  if (current === null || current.pidStart !== recorded.pidStart) return false;
  if (recorded.binary === undefined) return true;
  return basename(current.binary) === basename(normalizeBinary(recorded.binary));
}

export function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export interface KillDeps {
  isAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * SIGTERM then SIGKILL a group. Returns true only when the group was observed
 * alive and is confirmed dead afterwards; false if it was already gone or
 * survived the SIGKILL window. Callers must not finalize a stop on false.
 */
export async function killTreeWith(pid: number, graceMs: number, deps: KillDeps): Promise<boolean> {
  if (!deps.isAlive(pid)) return false;
  await deps.signal(pid, "SIGTERM");
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    if (!deps.isAlive(pid)) return true;
    await deps.sleep(20);
  }
  await deps.signal(pid, "SIGKILL");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!deps.isAlive(pid)) return true;
    await deps.sleep(20);
  }
  return !deps.isAlive(pid);
}

/** Terminate a process group this runner owns. See killTreeWith for semantics. */
export async function killTree(pid: number, options: { graceMs?: number } = {}): Promise<boolean> {
  return killTreeWith(pid, options.graceMs ?? DEFAULT_GRACE, {
    isAlive: isGroupAlive,
    signal: signalGroup,
    sleep,
  });
}

/** Boot cleanup: only kills when the recorded identity still matches exactly. */
export async function killOrphan(
  recorded: ProcessIdentity,
  options: { graceMs?: number } = {},
): Promise<{ matched: boolean; killed: boolean }> {
  const matched = await matchesProcess(recorded);
  if (!matched) return { matched: false, killed: false };
  return { matched: true, killed: await killTree(recorded.pid, options) };
}

export async function spawnIdentity(
  pid: number,
  cwd: string,
  generation: number,
): Promise<SpawnIdentity> {
  const identity = await identityWithRetry(pid);
  if (identity === null) {
    throw new DevChestraError("E_INTERNAL", `Cannot read process identity for pid ${pid}`);
  }
  return { ...identity, bin: identity.binary, pgid: pid, cwd, generation };
}
