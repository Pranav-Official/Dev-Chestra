import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock, withFileLock } from "../src/index.js";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "devchestra-lock-"));
  temps.push(dir);
  return dir;
}

describe("withFileLock", () => {
  it("serializes concurrent read-modify-write holders without lost updates", async () => {
    const dir = await scratch();
    const lockPath = join(dir, "auth.json.devchestra-lock");
    const counterPath = join(dir, "counter.txt");
    await writeFile(counterPath, "0", "utf8");
    const increment = async (): Promise<void> => {
      await withFileLock(
        lockPath,
        async () => {
          const current = Number(await readFile(counterPath, "utf8"));
          // Yield inside the critical section so unsynchronized holders
          // would interleave and lose increments.
          await new Promise((resolve) => setTimeout(resolve, 5));
          await writeFile(counterPath, String(current + 1), "utf8");
        },
        { staleMs: 5_000, pollMs: 5 },
      );
    };
    await Promise.all(Array.from({ length: 10 }, () => increment()));
    expect(await readFile(counterPath, "utf8")).toBe("10");
  });

  it("takes over a stale crashed holder", async () => {
    const dir = await scratch();
    const lockPath = join(dir, "auth.json.devchestra-lock");
    await mkdir(lockPath);
    // Dead pid plus an owner record nobody refreshes: takeover must succeed.
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, host: "elsewhere" }),
      "utf8",
    );
    const release = await acquireFileLock(lockPath, { staleMs: 50, pollMs: 5 });
    await release();
    // Released locks leave nothing behind for the next holder.
    await expect(
      acquireFileLock(lockPath, { staleMs: 50, pollMs: 5 }).then((r) => r()),
    ).resolves.toBeUndefined();
  });

  it("refuses a live holder and aborts on signal", async () => {
    const dir = await scratch();
    const lockPath = join(dir, "auth.json.devchestra-lock");
    const release = await acquireFileLock(lockPath, { staleMs: 60_000, pollMs: 5 });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      acquireFileLock(lockPath, { staleMs: 60_000, pollMs: 5, signal: controller.signal }),
    ).rejects.toThrow("stop");
    await release();
  });

  it("double release removes the lock once and never a successor", async () => {
    const dir = await scratch();
    const lockPath = join(dir, "auth.json.devchestra-lock");
    const first = await acquireFileLock(lockPath, { staleMs: 60_000, pollMs: 5 });
    await first();
    await first();
    const second = await acquireFileLock(lockPath, { staleMs: 60_000, pollMs: 5 });
    await second();
  });

  it("heartbeat keeps a live holder steal-proof past 3*staleMs (TD-003)", async () => {
    const dir = await scratch();
    const lockPath = join(dir, "auth.json.devchestra-lock");
    const staleMs = 100;
    const release = await acquireFileLock(lockPath, {
      staleMs,
      heartbeatMs: 20,
      pollMs: 10,
    });
    try {
      // Hold well past the old steal threshold for a live local holder
      // (age > 3*staleMs with `gone === false`). Heartbeat utimes on the
      // lock dir must keep its mtime fresh; only rewriting owner.json
      // does not bump dir mtime on POSIX.
      await new Promise((resolve) => setTimeout(resolve, 450));
      const ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      expect(ageMs).toBeLessThan(staleMs);
      // A second waiter must NOT steal the live lock: abort it and
      // expect an abort error rather than acquisition.
      const controller = new AbortController();
      const pending = acquireFileLock(lockPath, {
        staleMs,
        pollMs: 10,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      controller.abort(new Error("stop"));
      await expect(pending).rejects.toThrow("stop");
    } finally {
      await release();
    }
  });

  it("takes over a stranded bare dir with no owner.json (TD-003)", async () => {
    const dir = await scratch();
    const lockPath = join(dir, "auth.json.devchestra-lock");
    // Simulates kill between mkdir (atomic acquire) and owner.json write:
    // bare dir, no owner record. Must become stealable once stale,
    // not strand waiters forever.
    await mkdir(lockPath);
    const ancient = new Date(Date.now() - 1_000);
    await utimes(lockPath, ancient, ancient);
    const release = await acquireFileLock(lockPath, { staleMs: 50, pollMs: 5 });
    expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))?.pid).toBe(process.pid);
    await release();
  });
});
