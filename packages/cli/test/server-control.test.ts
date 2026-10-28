import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processIdentity } from "../src/lock.js";
import { serverStatus, stopServer } from "../src/server-control.js";
import { serverMetadataPath } from "../src/server-metadata.js";

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-stop-"));
  dirs.push(dir);
  return dir;
}

/** A stand-in "server": a real process that either exits on SIGTERM or ignores it. */
async function fakeServer(ignoreTerm = false): Promise<ChildProcess> {
  const code = ignoreTerm
    ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('up')"
    : "setInterval(()=>{},1000);console.log('up')";
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
  return child;
}

function writeMeta(
  dataDir: string,
  fields: { pid: number; pidStart?: string | null; mode?: number },
): void {
  const pidStart = fields.pidStart ?? processIdentity(fields.pid) ?? "unknown";
  writeFileSync(
    serverMetadataPath(dataDir),
    JSON.stringify({
      version: "0.1.0",
      pid: fields.pid,
      pidStart,
      port: 4999,
      token: "t".repeat(43),
      instanceId: "instance-1",
      startedAt: Date.now() - 65_000,
    }),
    { mode: fields.mode ?? 0o600 },
  );
}

const answer = (activeRuns: number) =>
  (async () =>
    new Response(JSON.stringify({ counts: { activeRuns }, projects: [{}, {}] }), {
      status: 200,
    })) as unknown as typeof fetch;

describe("serverStatus", () => {
  it("reports stopped when there is no record", async () => {
    expect((await serverStatus(tempDir())).state).toBe("stopped");
  });

  it("reports running with url, uptime and active runs from the server", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number });
    const status = await serverStatus(dir, { fetch: answer(2) });
    expect(status).toMatchObject({
      state: "running",
      pid: child.pid,
      url: "http://127.0.0.1:4999/",
      activeRuns: 2,
      projects: 2,
    });
    expect(status.uptimeMs).toBeGreaterThanOrEqual(60_000);
    expect(JSON.stringify(status)).not.toContain("t".repeat(43));
  });

  it("still reports running with unknown runs when the server does not answer", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number });
    const failing = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const status = await serverStatus(dir, { fetch: failing });
    expect(status).toMatchObject({ state: "running", activeRuns: null });
  });

  it("treats a dead pid as a stale record", async () => {
    const dir = tempDir();
    const done = spawnSync(process.execPath, ["-e", "0"]);
    writeMeta(dir, { pid: done.pid as number, pidStart: "linux:boot:1" });
    expect((await serverStatus(dir)).state).toBe("stale");
  });

  it("treats a recycled pid (different start time) as stale, not running", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number, pidStart: "linux:other-boot:12345" });
    expect((await serverStatus(dir)).state).toBe("stale");
  });

  it("flags an unsafe record instead of trusting it", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number, mode: 0o644 });
    expect((await serverStatus(dir)).state).toBe("unsafe");
  });
});

describe("stopServer", () => {
  it("is a no-op when nothing is running", async () => {
    const outcome = await stopServer(tempDir(), { force: false, timeoutMs: 1000 });
    expect(outcome).toMatchObject({ result: "not-running", cleanedStaleRecord: false });
  });

  it("clears a stale record without signalling anything", async () => {
    const dir = tempDir();
    const done = spawnSync(process.execPath, ["-e", "0"]);
    writeMeta(dir, { pid: done.pid as number, pidStart: "linux:boot:1" });
    const signals: string[] = [];
    const outcome = await stopServer(
      dir,
      { force: false, timeoutMs: 1000 },
      { kill: (_pid, signal) => void signals.push(signal) },
    );
    expect(outcome).toMatchObject({ result: "not-running", cleanedStaleRecord: true });
    expect(signals).toEqual([]);
    expect(existsSync(serverMetadataPath(dir))).toBe(false);
  });

  it("never signals a recycled pid", async () => {
    const dir = tempDir();
    const innocent = await fakeServer();
    writeMeta(dir, { pid: innocent.pid as number, pidStart: "linux:other-boot:12345" });
    const outcome = await stopServer(dir, { force: true, timeoutMs: 1000 });
    expect(outcome.result).toBe("not-running");
    expect(innocent.exitCode).toBeNull();
    expect(innocent.killed).toBe(false);
  });

  it("refuses while runs are active unless forced", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number });
    const refused = await stopServer(dir, { force: false, timeoutMs: 1000 }, { fetch: answer(3) });
    expect(refused).toMatchObject({ result: "refused" });
    expect(child.exitCode).toBeNull();

    const forced = await stopServer(dir, { force: true, timeoutMs: 5000 }, { fetch: answer(3) });
    expect(forced).toMatchObject({ result: "stopped", killed: false });
    expect(existsSync(serverMetadataPath(dir))).toBe(false);
  });

  it("stops a server with SIGTERM and clears its record", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const outcome = await stopServer(dir, { force: false, timeoutMs: 5000 }, { fetch: answer(0) });
    await exited;
    expect(outcome).toMatchObject({ result: "stopped", killed: false });
    expect(existsSync(serverMetadataPath(dir))).toBe(false);
  });

  it("reports failure when the server ignores SIGTERM and --force is absent", async () => {
    const dir = tempDir();
    const child = await fakeServer(true);
    writeMeta(dir, { pid: child.pid as number });
    const outcome = await stopServer(dir, { force: false, timeoutMs: 400 }, { fetch: answer(0) });
    expect(outcome.result).toBe("failed");
    expect(child.exitCode).toBeNull();
    expect(existsSync(serverMetadataPath(dir))).toBe(true);
  });

  it("escalates to SIGKILL with --force", async () => {
    const dir = tempDir();
    const child = await fakeServer(true);
    writeMeta(dir, { pid: child.pid as number });
    const outcome = await stopServer(dir, { force: true, timeoutMs: 400 }, { fetch: answer(0) });
    expect(outcome).toMatchObject({ result: "stopped", killed: true });
    expect(existsSync(serverMetadataPath(dir))).toBe(false);
  });

  it("refuses to act on an unsafe record", async () => {
    const dir = tempDir();
    const child = await fakeServer();
    writeMeta(dir, { pid: child.pid as number, mode: 0o644 });
    const outcome = await stopServer(dir, { force: true, timeoutMs: 500 });
    expect(outcome.result).toBe("failed");
    expect(child.exitCode).toBeNull();
  });
});
