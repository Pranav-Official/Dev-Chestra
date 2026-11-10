import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CONTAINER_HOME,
  containerProviders,
  containerRuntimeArgs,
  DEFAULT_SANDBOX_IMAGE,
  detectContainerRuntime,
  ensureCredentialVolume,
  forgeCredentialFile,
  runtimeEnv,
} from "@devchestra/adapters";
import { acquireScratch, prepareRunWorkspace, removeScratch } from "@devchestra/workspaces";
import { defaultDataDir } from "./data-dir.js";
import { acquireDataDirLock } from "./lock.js";
import { SANDBOX_CONTAINERFILE } from "./sandbox-image.js";

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: runtimeEnv(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
export async function executeSandbox(argv: string[]): Promise<number> {
  const action = argv[0];
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };
  const dataDir = resolve(value("--data-dir") ?? defaultDataDir());
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (action === "build") {
    const runtime = detectContainerRuntime(dataDir, process.env, false);
    const scratch = mkdtempSync(join(tmpdir(), "dc-image-"));
    try {
      const file = value("--file")
        ? resolve(value("--file") as string)
        : join(scratch, "Containerfile");
      if (!value("--file")) writeFileSync(file, SANDBOX_CONTAINERFILE);
      return await run(
        runtime.bin,
        containerRuntimeArgs(runtime, [
          "build",
          "--tag",
          process.env.DEVCHESTRA_CONTAINER_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
          "--file",
          file,
          value("--context") ? resolve(value("--context") as string) : scratch,
        ]),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (action === "clean") {
    const project = value("--project");
    const projectId = value("--project-id");
    const runId = value("--run-id");
    if (!project || !projectId || !runId)
      throw new Error("sandbox clean requires --project <dir> --project-id <id> --run-id <id>");
    const lock = await acquireDataDirLock(dataDir);
    try {
      const file = join(dataDir, "projects", projectId, "runs", runId, "run-workspace.json");
      const stored = JSON.parse(readFileSync(file, "utf8"));
      if (stored.selection?.mode !== "container")
        throw new Error("This run does not own a container clone");
      const request = {
        dataDir,
        projectId,
        runId,
        projectRoot: realpathSync(project),
        selection: stored.selection,
        requireExisting: true,
      };
      const prepared = await prepareRunWorkspace(request);
      if (!prepared.ok) throw prepared.error;
      const dirty = spawnSync(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          prepared.value.dir,
          "status",
          "--porcelain",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (dirty.status !== 0 || (dirty.stdout.trim() && !argv.includes("--force")))
        throw new Error(
          "Clone contains uncommitted results; review them first or use --force to discard them",
        );
      const acquired = await acquireScratch({
        ...request,
        path: "cleanup",
        attempt: 1,
        generation: 1,
        runWorkspace: { projectRoot: request.projectRoot, selection: request.selection },
      });
      if (!acquired.ok) throw acquired.error;
      const removed = await removeScratch(acquired.value);
      if (!removed.ok) throw removed.error;
      process.stdout.write(
        "Container clone removed. Fetched branches and CLI login volumes are retained.\n",
      );
      return 0;
    } finally {
      await lock.release();
    }
  }
  if (action === "publish") {
    const project = value("--project");
    const id = value("--run-id");
    if (!project || !id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
      throw new Error("sandbox publish requires --project <dir> --run-id <id>");
    const cwd = realpathSync(project);
    const branch = `devchestra/run-${id}`;
    const invoke = (bin: string, args: string[]) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(bin, args, { cwd, env: runtimeEnv(), stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
    const pushed = await invoke("git", ["push", "--set-upstream", "origin", branch]);
    if (pushed !== 0) return pushed;
    return invoke("gh", [
      "pr",
      "create",
      "--head",
      branch,
      "--base",
      value("--base") ?? "main",
      "--fill",
    ]);
  }
  if (action === "login" && argv[1] === "github") {
    const project = value("--project");
    if (!project) throw new Error("GitHub login requires --project <dir>");
    const account = value("--account");
    if (!account && !argv.includes("--stdin"))
      throw new Error(
        "Supply a scoped token using --stdin, or explicitly reuse a host gh account using --account <user>",
      );
    const token = account ? undefined : readFileSync(0, "utf8").trim();
    if (token !== undefined && (!token || /[\r\n\0]/.test(token)))
      throw new Error("Invalid GitHub token");
    const file = forgeCredentialFile(dataDir, project);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(account ? { account } : { token }), { mode: 0o600 });
    chmodSync(file, 0o600);
    process.stdout.write("GitHub credential configured for this project.\n");
    return 0;
  }
  if (action === "login") {
    const cli = argv[1] === "claude" ? "claude-code" : argv[1];
    if (!cli || !(cli in containerProviders))
      throw new Error("Use sandbox login claude|codex|pi|opencode");
    const provider = containerProviders[cli as keyof typeof containerProviders];
    const runtime = detectContainerRuntime(dataDir);
    const volume = ensureCredentialVolume(runtime, cli);
    const args = [
      "run",
      "--rm",
      "--init",
      "--interactive",
      ...(process.stdin.isTTY ? ["--tty"] : []),
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      ...(runtime.bin === "podman" ? ["--userns=keep-id"] : []),
      "--user",
      `${runtime.uid}:${runtime.gid}`,
      "--env",
      `HOME=${CONTAINER_HOME}`,
      "--volume",
      `${volume}:${CONTAINER_HOME}`,
      "--entrypoint",
      provider.bin,
      runtime.image,
      ...provider.login,
    ];
    return run(runtime.bin, containerRuntimeArgs(runtime, args));
  }
  process.stdout.write(
    "devchestra sandbox build [--file Containerfile --context dir] [--data-dir dir]\ndevchestra sandbox login claude|codex|pi|opencode [--data-dir dir]\nConfigure DEVCHESTRA_CONTAINER_RUNTIME=podman|docker and DEVCHESTRA_CONTAINER_IMAGE.\n",
  );
  return action === undefined || action === "--help" ? 0 : 4;
}
