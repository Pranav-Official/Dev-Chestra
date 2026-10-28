import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = resolve(import.meta.dirname, "../dist/main.js");
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { code: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// Needs the built CLI (`pnpm build`); the root `pnpm test` builds first.
describe.skipIf(!existsSync(MAIN))("devchestra status / stop against a real server", () => {
  it("reports, stops and reports again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devchestra-e2e-"));
    dirs.push(dir);
    const server = spawn(
      process.execPath,
      [MAIN, "start", "--data-dir", dir, "--no-open", "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(server);
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("server did not become ready")), 20_000);
      server.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("devchestra.ready")) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const exited = new Promise<number | null>((done) => server.once("exit", (code) => done(code)));

    const running = run(["status", "--data-dir", dir, "--json"]);
    expect(running.code).toBe(0);
    const parsed = JSON.parse(running.out) as Record<string, unknown>;
    expect(parsed).toMatchObject({ state: "running", pid: server.pid, activeRuns: 0 });
    expect(running.out).not.toContain("token");

    const stopped = run(["stop", "--data-dir", dir]);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("stopped");
    expect(await exited).toBe(0);

    expect(run(["status", "--data-dir", dir]).code).toBe(1);
    const again = run(["stop", "--data-dir", dir]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("not running");
  }, 60_000);
});
