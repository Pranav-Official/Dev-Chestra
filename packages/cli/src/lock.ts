import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DevChestraError } from "@devchestra/core";

export interface LockOwner {
  pid: number;
  pidStart: string;
  token: string;
  startedAt: number;
  version: string;
}

export interface LockHandle {
  owner: LockOwner;
  recoveredStale: boolean;
  release: () => Promise<void>;
}

export interface LockInspection {
  locked: boolean;
  live: boolean;
  ambiguous: boolean;
  owners: LockOwner[];
}

export class DataDirLockedError extends Error {
  readonly owner: LockOwner | null;

  constructor(owner: LockOwner | null, ambiguous = false) {
    super(
      ambiguous
        ? "The data-directory lock has no readable owner. Inspect or remove devchestra.lock manually."
        : owner === null
          ? "Another DevChestra process owns this data directory."
          : `Another DevChestra process owns this data directory (pid ${owner.pid}).`,
    );
    this.name = "DataDirLockedError";
    this.owner = owner;
  }
}

const LOCK_DIR = "devchestra.lock";
const OWNER_PREFIX = "owner.";
const OWNER_SUFFIX = ".json";

function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function processIdentity(pid: number): string | null {
  const boot = bootId();
  if (boot !== null) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close !== -1) {
        const fields = stat.slice(close + 2).split(" ");
        const startTicks = fields[19];
        if (startTicks !== undefined && /^\d+$/.test(startTicks)) {
          return `linux:${boot}:${startTicks}`;
        }
      }
    } catch {
      // Fall back to ps below (for example when /proc is unavailable).
    }
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const value = result.stdout.trim();
  return value === "" ? null : `posix:${value}`;
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerName(token: string): string {
  return `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`;
}

function parseOwner(text: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      typeof value.pidStart !== "string" ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "number" ||
      typeof value.version !== "string"
    ) {
      return null;
    }
    return {
      pid: value.pid,
      pidStart: value.pidStart,
      token: value.token,
      startedAt: value.startedAt,
      version: value.version,
    };
  } catch {
    return null;
  }
}

/** Read every owner file. A missing/unreadable owner is ambiguous, never stale. */
async function readOwners(lockDir: string): Promise<LockOwner[] | null> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
  const files = names.filter(
    (name) => name.startsWith(OWNER_PREFIX) && name.endsWith(OWNER_SUFFIX),
  );
  if (files.length === 0) return null;
  const owners: LockOwner[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(lockDir, file), "utf8");
    } catch {
      return null;
    }
    const owner = parseOwner(text);
    if (owner === null || ownerName(owner.token) !== file) return null;
    owners.push(owner);
  }
  return owners;
}

type OwnerState = "live" | "dead" | "unknown";

function ownerState(owner: LockOwner): OwnerState {
  if (!processAlive(owner.pid)) return "dead";
  const current = processIdentity(owner.pid);
  if (current === null) return "unknown";
  return current === owner.pidStart ? "live" : "dead";
}

export async function inspectDataDirLock(dataDir: string): Promise<LockInspection> {
  const lockDir = join(dataDir, LOCK_DIR);
  const owners = await readOwners(lockDir);
  if (owners === null) {
    return { locked: true, live: false, ambiguous: true, owners: [] };
  }
  if (owners.length === 0) {
    return { locked: false, live: false, ambiguous: false, owners: [] };
  }
  const states = owners.map(ownerState);
  return {
    locked: true,
    live: states.includes("live"),
    ambiguous: states.includes("unknown"),
    owners,
  };
}

const RECLAIM_MARKER = "reclaim.json";

interface ReclaimMarker {
  pid: number;
  pidStart: string;
  token: string;
  startedAt: number;
}

async function readReclaimMarker(lockDir: string): Promise<ReclaimMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(lockDir, RECLAIM_MARKER), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      typeof value.pidStart !== "string" ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "number"
    ) {
      return null;
    }
    return {
      pid: value.pid,
      pidStart: value.pidStart,
      token: value.token,
      startedAt: value.startedAt,
    };
  } catch {
    return null;
  }
}

async function removeMarkerIfOwned(lockDir: string, token: string): Promise<void> {
  const marker = await readReclaimMarker(lockDir);
  if (marker === null || marker.token !== token) return;
  await unlink(join(lockDir, RECLAIM_MARKER)).catch(() => undefined);
}

async function takeReclaimMarker(lockDir: string): Promise<string | null> {
  const self = processIdentity(process.pid);
  if (self === null) return null;
  const token = randomBytes(12).toString("base64url");
  const marker: ReclaimMarker = {
    pid: process.pid,
    pidStart: self,
    token,
    startedAt: Date.now(),
  };
  try {
    await writeFile(join(lockDir, RECLAIM_MARKER), `${JSON.stringify(marker)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
  }
  const existing = await readReclaimMarker(lockDir);
  if (existing === null) return null;
  if (!processAlive(existing.pid)) {
    await removeMarkerIfOwned(lockDir, existing.token);
  }
  return null;
}

/**
 * Reclaim only via an exclusive marker and an atomic rename of the whole lock
 * directory. The shared `devchestra.lock` path is never rmdir'd, so a racing
 * reclaimer cannot delete a freshly created empty lock directory.
 */
async function reclaimStale(lockDir: string, owners: LockOwner[]): Promise<boolean> {
  if (owners.length === 0) return false;
  const token = await takeReclaimMarker(lockDir);
  if (token === null) return false;
  try {
    const current = await readOwners(lockDir);
    if (current === null || current.length === 0) return false;
    const states = current.map((owner) => ({ owner, state: ownerState(owner) }));
    if (states.some((entry) => entry.state !== "dead")) return false;
    const tombstone = `${lockDir}.reclaim.${token}`;
    await rename(lockDir, tombstone);
    await rm(tombstone, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    await removeMarkerIfOwned(lockDir, token);
  }
}

/**
 * Atomic mkdir lock with a token-named owner file. Staleness is decided by
 * PID + boot/start identity, never by an expired heartbeat. Reclaim unlinks
 * only the owner files it observed and then uses non-recursive rmdir, so a
 * newly acquired lock at the same path cannot be deleted by a racing reclaimer.
 */
export interface AcquireLockOptions {
  /** Doctor uses false: never reclaim even a dead-owner lock. */
  allowStaleReclaim?: boolean;
}

export async function acquireDataDirLock(
  dataDir: string,
  version = "0.1.0",
  options: AcquireLockOptions = {},
): Promise<LockHandle> {
  const allowStaleReclaim = options.allowStaleReclaim ?? true;
  try {
    const existing = await lstat(dataDir);
    if (existing.isSymbolicLink()) {
      throw new DevChestraError(
        "E_CONFLICT",
        "The data directory must not be a symlink; pass the real directory path.",
      );
    }
    if (!existing.isDirectory()) {
      throw new DevChestraError("E_VALIDATION", "The data directory is not a directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockDir = join(dataDir, LOCK_DIR);
  const selfStart = processIdentity(process.pid);
  if (selfStart === null) {
    throw new Error("Cannot determine this process start identity for the data-dir lock.");
  }
  const owner: LockOwner = {
    pid: process.pid,
    pidStart: selfStart,
    token: randomBytes(16).toString("base64url"),
    startedAt: Date.now(),
    version,
  };
  let recoveredStale = false;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(join(lockDir, ownerName(owner.token)), `${JSON.stringify(owner)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return {
        owner,
        recoveredStale,
        release: async (): Promise<void> => {
          try {
            await unlink(join(lockDir, ownerName(owner.token)));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          try {
            await rmdir(lockDir);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }

    let owners = await readOwners(lockDir);
    for (let wait = 0; wait < 20 && (owners === null || owners.length === 0); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      owners = await readOwners(lockDir);
    }
    if (owners === null || owners.length === 0) {
      throw new DataDirLockedError(null, true);
    }
    const states = owners.map((owner) => ({ owner, state: ownerState(owner) }));
    const live = states.find((entry) => entry.state === "live");
    if (live !== undefined) {
      throw new DataDirLockedError(live.owner);
    }
    if (states.some((entry) => entry.state === "unknown")) {
      throw new DataDirLockedError(null, true);
    }
    if (!allowStaleReclaim) {
      throw new DataDirLockedError(owners[0] ?? null);
    }
    if (await reclaimStale(lockDir, owners)) {
      recoveredStale = true;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new DataDirLockedError(null, true);
}
