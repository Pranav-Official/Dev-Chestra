import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "../src/index.js";
import { cleanup, tempDir, unwrap } from "./helpers.js";

afterEach(cleanup);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function fixture(includeUncommitted = false) {
  const root = tempDir("dc-container-project-");
  const dataDir = tempDir("dc-container-data-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "tracked"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  const request = {
    dataDir,
    projectRoot: root,
    projectId: "project",
    runId: "run",
    selection: { mode: "container" as const, includeUncommitted },
  };
  return { root, dataDir, base, request };
}

describe.skipIf(process.platform !== "linux")("container clone", () => {
  it("creates an independent clone, fetches commits without touching project files, and retains dirty edits", async () => {
    const f = fixture();
    const prepared = unwrap(await prepareRunWorkspace(f.request));
    expect(prepared.dir).not.toBe(f.root);
    expect(existsSync(join(prepared.dir, ".git/objects/info/alternates"))).toBe(false);
    expect(git(prepared.dir, "rev-parse", "HEAD")).toBe(f.base);
    writeFileSync(join(prepared.dir, "tracked"), "committed result\n");
    git(prepared.dir, "add", ".");
    git(prepared.dir, "commit", "-m", "result");
    writeFileSync(join(prepared.dir, "extra"), "uncommitted result");
    const workspace = unwrap(
      await acquireScratch({
        ...f.request,
        path: "shell",
        attempt: 1,
        generation: 1,
        requireExisting: true,
        runWorkspace: { projectRoot: f.root, selection: f.request.selection },
      }),
    );
    unwrap(
      await finalizeScratch(workspace, {
        outcome: "success",
        process: { attempt: 1, generation: 1, stopped: true, reason: "exited", exitCode: 0 },
      }),
    );
    releaseScratch(workspace);
    expect(git(f.root, "show", "devchestra/run-run:tracked")).toBe("committed result");
    expect(readFileSync(join(f.root, "tracked"), "utf8")).toBe("base\n");
    expect(readFileSync(join(prepared.dir, "extra"), "utf8")).toBe("uncommitted result");
    expect(unwrap(await prepareRunWorkspace({ ...f.request, requireExisting: true })).dir).toBe(
      prepared.dir,
    );
    rmSync(prepared.dir, { recursive: true });
    expect((await prepareRunWorkspace({ ...f.request, requireExisting: true })).ok).toBe(false);
  });
  it("imports tracked binary changes only when requested", async () => {
    const f = fixture(true);
    const bytes = Buffer.from([0, 1, 255, 0, 10]);
    writeFileSync(join(f.root, "tracked"), bytes);
    writeFileSync(join(f.root, "untracked"), "private");
    const prepared = unwrap(await prepareRunWorkspace(f.request));
    expect(readFileSync(join(prepared.dir, "tracked"))).toEqual(bytes);
    expect(existsSync(join(prepared.dir, "untracked"))).toBe(false);
  });
  it("rejects non-git projects", async () => {
    const f = fixture();
    const root = tempDir("dc-non-git-");
    expect((await prepareRunWorkspace({ ...f.request, projectRoot: root })).ok).toBe(false);
  });
});
