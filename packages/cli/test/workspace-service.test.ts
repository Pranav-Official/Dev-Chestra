import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserWorkspaceService,
  validateWorkspaceSelection,
} from "../src/workspace-service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix = "devchestra-cli-ws-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "DevChestra Test",
      GIT_AUTHOR_EMAIL: "devchestra@example.invalid",
      GIT_COMMITTER_NAME: "DevChestra Test",
      GIT_COMMITTER_EMAIL: "devchestra@example.invalid",
    },
  }).trim();
}

function repo(): { root: string; worktree: string } {
  const root = tempDir("devchestra-cli-repo-");
  git(root, ["init", "-q"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "base"]);
  const worktree = join(tempDir("devchestra-cli-wt-"), "tree");
  git(root, ["worktree", "add", "--detach", "-q", worktree, "HEAD"]);
  return { root, worktree };
}

describe("CLI workspace selection", () => {
  it("lists the project root separately and validates listed worktrees", async () => {
    const { root, worktree } = repo();
    const request = { mode: "existing-worktree" as const, path: worktree };
    await expect(validateWorkspaceSelection(root, request)).resolves.toEqual(request);
    await expect(validateWorkspaceSelection(root, { mode: "new-worktree" })).resolves.toEqual({
      mode: "new-worktree",
    });
    await expect(validateWorkspaceSelection(root, { mode: "project" })).resolves.toEqual({
      mode: "project",
    });

    const service = createBrowserWorkspaceService();
    const catalog = await service.catalog(root);
    expect(catalog.git).toBe(true);
    expect(catalog.projectRoot).toBe(root);
    expect(catalog.worktrees.map((entry) => entry.path)).toEqual([worktree]);
  });

  it("rejects unlisted paths, the project root and non-Git projects", async () => {
    const { root } = repo();
    const elsewhere = tempDir("devchestra-cli-elsewhere-");
    await expect(
      validateWorkspaceSelection(root, { mode: "existing-worktree", path: elsewhere }),
    ).rejects.toMatchObject({ code: "E_VALIDATION" });
    await expect(
      validateWorkspaceSelection(root, { mode: "existing-worktree", path: root }),
    ).rejects.toMatchObject({ code: "E_VALIDATION" });

    const plain = tempDir("devchestra-cli-plain-");
    await expect(validateWorkspaceSelection(plain, { mode: "new-worktree" })).rejects.toMatchObject(
      { code: "E_VALIDATION" },
    );
  });
});
