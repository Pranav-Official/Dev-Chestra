import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export interface FileLockOptions {
  /** Abort waiting (never aborts a held lock; release in finally instead). */
  signal?: AbortSignal;
  /** Take over when the heartbeat is older than this. Default 30_000. */
  staleMs?: number;
  /** Heartbeat while held. Default staleMs / 3. */
  heartbeatMs?: number;
  /** Poll interval while waiting. Default 50. */
  pollMs?: number;
}

export type ReleaseFileLock = () => Promise<void>;

function abortError(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("lock acquisition aborted");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function holderAlive(pid: number, host: string): boolean {
  // A remote holder cannot be signalled; its heartbeat mtime is the only
  // liveness signal, so it counts as gone here and staleness decides.
  if (!Number.isSafeInteger(pid) || pid <= 0 || host !== hostname()) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Mutual exclusion across processes on one host for a canonical path.
 * The lock is the directory at `lockPath` (mkdir is atomic); the owner
 * record inside carries pid/host for stale takeover after crashes.
 * Only the acquirer removes it, and only while it still owns it, so a
 * stale-takeover successor is never deleted by its predecessor's release.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<ReleaseFileLock> {
  const staleMs = options.staleMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? Math.floor(staleMs / 3);
  const pollMs = options.pollMs ?? 50;
  const ownerPath = join(lockPath, "owner.json");
  const me = JSON.stringify({ pid: process.pid, host: hostname() });

  for (;;) {
    options.signal?.throwIfAborted();
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, me, "utf8");
      } catch (writeError) {
        // mkdir succeeded but the owner record could not be written
        // (crash/kill between the two, ENOSPC, ...): remove the bare
        // dir so the next waiter does not block on a stranded lock
        // with no owner.json.
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw writeError;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        // mtimeMs is wall-clock, so age must use Date.now() (monotonic
        // clocks cannot be compared against file mtimes).
        const info = await stat(lockPath);
        const ageMs = Date.now() - info.mtimeMs;
        let owner: { pid?: unknown; host?: unknown } = {};
        try {
          const raw = await readFile(ownerPath, "utf8");
          try {
            owner = JSON.parse(raw) as { pid?: unknown; host?: unknown };
          } catch {
            // Half-written owner: treat as gone, staleness decides below.
          }
        } catch {
          // Missing/unreadable owner (e.g. killed between mkdir and
          // writeFile): owner stays {} so `gone` is true and a stale
          // bare dir becomes stealable instead of stranding waiters.
        }
        const pid = typeof owner.pid === "number" ? owner.pid : -1;
        const host = typeof owner.host === "string" ? owner.host : "";
        const gone = !holderAlive(pid, host);
        if (ageMs > staleMs && (gone || ageMs > 3 * staleMs)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // stat/takeover raced mid-handover: keep waiting.
      }
      await sleep(pollMs, options.signal);
    }
  }

  const beat = setInterval(() => {
    // Refreshing owner.json alone does NOT bump the lock-dir mtime on
    // POSIX (only entry create/remove does), while liveness is checked
    // against the dir mtime — so the heartbeat must utimes the dir
    // itself, otherwise a live holder looks dead after ~3*staleMs.
    (async () => {
      await writeFile(ownerPath, me);
      await utimes(lockPath, new Date(), new Date());
    })().catch(() => undefined);
  }, heartbeatMs);
  if (typeof (beat as unknown as { unref?: unknown }).unref === "function") {
    (beat as unknown as { unref: () => void }).unref();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
        pid?: unknown;
        host?: unknown;
      };
      if (owner?.pid === process.pid && owner?.host === hostname()) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Already taken over or removed.
    }
  };
}

/** Run `fn` while holding the file lock at `lockPath`. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
