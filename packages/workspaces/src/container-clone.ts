import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunWorkspaceSelection } from "@devchestra/core";
import { DevChestraError } from "@devchestra/core";
import { acquireLock, conflict, dirIdentity, ownedDir, releaseLock } from "./worktree-git.js";

function git(cwd: string, args: string[], input?: Buffer): Buffer {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "-C", cwd, ...args],
    {
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      input,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new DevChestraError("E_WORKSPACE", `Container clone Git operation failed (${args[0]})`, {
      details: { stderr: result.stderr?.toString().slice(0, 2048) },
    });
  return result.stdout;
}

/** Validate the standalone repository before any host-side Git operation. */
export function validateContainerClone(dir: string): void {
  ownedDir(dir, "Container clone");
  ownedDir(path.join(dir, ".git"), "Container clone Git directory");
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    .toString()
    .trim();
  if (
    common !== path.join(dir, ".git") ||
    fs.existsSync(path.join(common, "objects/info/alternates"))
  ) {
    throw conflict("Container clone must have an independent Git object store");
  }
}

export async function prepareContainerClone(
  runDir: string,
  root: string,
  base: string,
  selection: RunWorkspaceSelection,
  signal?: AbortSignal,
): Promise<string> {
  const lock = await acquireLock(runDir, signal);
  const dir = path.join(runDir, "clone");
  try {
    const marker = path.join(runDir, "container-clone.json");
    if (fs.existsSync(dir)) {
      validateContainerClone(dir);
      if (
        !fs.existsSync(marker) ||
        JSON.parse(fs.readFileSync(marker, "utf8")).dirId !== dirIdentity(dir)
      )
        throw conflict("Container clone identity changed or creation was interrupted");
      return dir;
    }
    if (fs.existsSync(marker))
      throw conflict("Container clone is missing; refusing to recreate it");
    // Transport cloning avoids local alternates/hardlinks and honors a pinned commit.
    git(runDir, ["clone", "--no-local", "--no-checkout", "--", root, dir]);
    git(dir, ["checkout", "--detach", base]);
    for (const name of ["user.name", "user.email"]) {
      const result = spawnSync("git", ["-C", root, "config", "--get", name], { encoding: "utf8" });
      if (result.status === 0) git(dir, ["config", name, result.stdout.trim()]);
    }
    const remote = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
    });
    git(dir, ["remote", "remove", "origin"]);
    if (remote.status === 0) {
      const url = remote.stdout
        .trim()
        .replace(/^git@([^:]+):/, "https://$1/")
        .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/");
      if (!/^https:\/\/[^/@]+\//.test(url))
        throw new DevChestraError(
          "E_VALIDATION",
          "Container origin must be HTTPS without embedded credentials",
        );
      git(dir, ["remote", "add", "origin", url]);
    }
    if (selection.mode === "container" && selection.includeUncommitted === true) {
      const patch = git(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
      if (patch.length > 0) git(dir, ["apply", "--binary", "-"], patch);
    }
    fs.writeFileSync(marker, JSON.stringify({ version: 1, dirId: dirIdentity(dir), base }), {
      flag: "wx",
      mode: 0o600,
    });
    return dir;
  } finally {
    releaseLock(lock);
  }
}

/** Fetch commits only. Dirty/untracked results stay in the retained clone. */
export async function fetchContainerClone(
  runDir: string,
  root: string,
  dir: string,
  runId: string,
): Promise<void> {
  const lock = await acquireLock(runDir, undefined);
  try {
    validateContainerClone(dir);
    git(root, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      dir,
      `HEAD:refs/heads/devchestra/run-${runId}`,
    ]);
  } finally {
    releaseLock(lock);
  }
}
