import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { DevChestraError } from "../errors.js";

/** A lock older than this is taken over even if its owner pid looks alive (pid reuse, hung owner). */
const STALE_LOCK_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 50;

interface LockOwner {
  pid: number;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, token } = parsed as Record<string, unknown>;
    return typeof pid === "number" && typeof token === "string" ? { pid, token } : null;
  } catch {
    return null;
  }
}

function lockIsStale(path: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false; // released while we looked; the next attempt will just take it
  }
  if (ageMs > STALE_LOCK_MS) return true;
  const owner = readOwner(path);
  // An unreadable owner is a lock mid-write; give it the stale window before taking over.
  return owner !== null && !processIsAlive(owner.pid);
}

function tryCreate(path: string, owner: LockOwner): boolean {
  let fd: number;
  try {
    // "wx" is O_CREAT | O_EXCL: it fails if anything, even a symlink, is already there.
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseIfOwned(path: string, token: string): void {
  // Only remove a lock that is still ours; one taken over after we stalled belongs to someone else.
  if (readOwner(path)?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Removes a stale lock, but only if it is still the same stale lock we inspected. */
function takeOverStale(path: string): void {
  const before = readOwner(path);
  if (!lockIsStale(path)) return;
  if (before !== null && readOwner(path)?.token !== before.token) return;
  try {
    unlinkSync(path);
  } catch {
    /* another process took it over first */
  }
}

/**
 * Runs `run` while holding an exclusive lock file, so the work is serialized across processes
 * and not only inside this one. The lock records its owner pid and a random token; a lock whose
 * owner died, or that is older than the stale window, is taken over. A lock that cannot be
 * acquired before the timeout raises E_CONFLICT.
 */
export async function withFileLock<T>(
  path: string,
  run: () => Promise<T> | T,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const owner: LockOwner = { pid: process.pid, token: randomBytes(12).toString("hex") };
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (!tryCreate(path, owner)) {
    takeOverStale(path);
    if (Date.now() >= deadline) {
      throw new DevChestraError(
        "E_CONFLICT",
        "Settings are being changed by another DevChestra process. Retry in a moment.",
      );
    }
    const wait = MIN_BACKOFF_MS + Math.random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  try {
    return await run();
  } finally {
    releaseIfOwned(path, owner.token);
  }
}
