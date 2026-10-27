import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataDirLock, DataDirLockedError, inspectDataDirLock } from "../src/lock.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-cli-lock-"));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function deadOwnerLock(dir: string): Promise<void> {
  const lockDir = join(dir, "relay.lock");
  await mkdir(lockDir, { mode: 0o700 });
  await writeFile(
    join(lockDir, "owner.dead.json"),
    `${JSON.stringify({
      pid: 999_999,
      pidStart: "linux:dead:1",
      token: "dead",
      startedAt: Date.now(),
      version: "0.1.0",
    })}\n`,
    { mode: 0o600 },
  );
}

const CHILD = `
import { acquireDataDirLock } from ${JSON.stringify(new URL("../src/lock.ts", import.meta.url).href)};
try {
  const handle = await acquireDataDirLock(process.argv[1]);
  process.stdout.write("ACQUIRED\\n");
  await new Promise((resolve) => setTimeout(resolve, 60000));
  await handle.release();
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
  process.exitCode = 2;
}
`;

interface ChildRun {
  child: ReturnType<typeof spawn>;
  acquired: Promise<boolean>;
  exited: Promise<number | null>;
}

function runChild(dataDir: string): ChildRun {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", CHILD, dataDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  return {
    child,
    acquired: new Promise((resolve) => {
      child.stdout.on("data", () => {
        if (stdout.includes("ACQUIRED")) resolve(true);
      });
      child.once("exit", () => resolve(stdout.includes("ACQUIRED")));
    }),
    exited: new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
    }),
  };
}

describe("data-dir lock", () => {
  it("acquires, blocks a second owner, and releases", async () => {
    const dir = await tempDir();
    const first = await acquireDataDirLock(dir);
    await expect(acquireDataDirLock(dir)).rejects.toBeInstanceOf(DataDirLockedError);
    expect((await inspectDataDirLock(dir)).live).toBe(true);
    expect(existsSync(join(dir, "relay.lock", `owner.${first.owner.token}.json`))).toBe(true);
    await first.release();
    expect(existsSync(join(dir, "relay.lock"))).toBe(false);
  });

  it("rejects a symlinked data directory before creating lock or db state", async () => {
    const parent = await tempDir();
    const target = join(parent, "target");
    const link = join(parent, "link");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);
    await expect(acquireDataDirLock(link)).rejects.toThrow(/symlink/i);
    expect(existsSync(join(target, "relay.lock"))).toBe(false);
  });

  it("reclaims a dead owner but never a live owner", async () => {
    const dir = await tempDir();
    await deadOwnerLock(dir);
    const handle = await acquireDataDirLock(dir);
    expect(handle.recoveredStale).toBe(true);
    await expect(acquireDataDirLock(dir)).rejects.toBeInstanceOf(DataDirLockedError);
    expect(existsSync(join(dir, "relay.lock", `owner.${handle.owner.token}.json`))).toBe(true);
    await handle.release();
  });

  it("creates a new data directory owner-only and can refuse stale reclaim", async () => {
    const parent = await tempDir();
    const dataDir = join(parent, "new-data");
    const handle = await acquireDataDirLock(dataDir);
    const mode = (await stat(dataDir)).mode & 0o777;
    expect(mode).toBe(0o700);
    await handle.release();

    await deadOwnerLock(dataDir);
    await expect(
      acquireDataDirLock(dataDir, "0.1.0", { allowStaleReclaim: false }),
    ).rejects.toBeInstanceOf(DataDirLockedError);
    expect(existsSync(join(dataDir, "relay.lock"))).toBe(true);
  });

  it("fails closed on an ambiguous lock with no owner file", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "relay.lock"), { mode: 0o700 });
    await expect(acquireDataDirLock(dir)).rejects.toBeInstanceOf(DataDirLockedError);
    expect(existsSync(join(dir, "relay.lock"))).toBe(true);
  });

  it("allows exactly one of 20 concurrent processes to acquire a dead-owner lock", async () => {
    for (let round = 0; round < 3; round += 1) {
      const dir = await tempDir();
      await deadOwnerLock(dir);
      const runs = Array.from({ length: 20 }, () => runChild(dir));
      const acquired = await Promise.all(runs.map((run) => run.acquired));
      expect(acquired.filter(Boolean), `round ${round}`).toHaveLength(1);
      // The winner holds the lock for 60s; no sequential second acquisition is possible.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(acquired.filter(Boolean), `round ${round} stable`).toHaveLength(1);
      for (const run of runs) {
        if (run.child.exitCode === null) run.child.kill("SIGKILL");
      }
      await Promise.all(runs.map((run) => run.exited));
    }
  });
});
