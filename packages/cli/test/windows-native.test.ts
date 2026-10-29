import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildChildEnv,
  finalizeInvocation,
  killOrphan,
  materializeInvocation,
  readProcessIdentity,
  runCommand,
} from "@devchestra/adapters";
import type { Path, RunWorkspaceSelection } from "@devchestra/core";
import { renderTemplate } from "@devchestra/schema";
import { createNodeExpressionExecutor } from "@devchestra/schema/node";
import {
  acquireScratch,
  finalizeScratch,
  listProjectWorkspaces,
  releaseScratch,
} from "@devchestra/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataDirLock } from "../src/lock.js";
import { stopServer } from "../src/server-control.js";
import {
  createInstanceId,
  createSessionToken,
  writeServerMetadata,
} from "../src/server-metadata.js";

const main = resolve(import.meta.dirname, "../dist/main.js");
const directories: string[] = [];
const children: ChildProcess[] = [];
const env = () => buildChildEnv("fake");

function directory(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "devchestra windows spike ")));
  directories.push(dir);
  return dir;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  expect(check()).toBe(true);
}
function cli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [main, ...args], {
    cwd,
    env: { ...process.env, DEVCHESTRA_ALLOW_FAKE: "1" },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
}
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
});

describe.skipIf(process.platform !== "win32")("Windows native spike", () => {
  it("force-stops an identity-checked server when its control pipe is unavailable", async () => {
    const cwd = directory();
    const lock = await acquireDataDirLock(cwd);
    try {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd,
        windowsHide: true,
        stdio: "ignore",
      });
      children.push(child);
      const identity = await readProcessIdentity(child.pid as number);
      expect(identity).not.toBeNull();
      if (identity === null) return;
      await writeServerMetadata(cwd, {
        version: "0.1.0",
        pid: child.pid as number,
        pidStart: identity.pidStart,
        port: 1,
        token: createSessionToken(),
        instanceId: createInstanceId(),
        startedAt: Date.now(),
      });
      const result = await stopServer(cwd, { force: true, timeoutMs: 0 });
      expect(result.result).toBe("stopped");
      if (result.result === "stopped") expect(result.killed).toBe(true);
      expect(alive(child.pid as number)).toBe(false);
    } finally {
      await lock.release();
    }
  }, 20000);
  it("creates and reopens all three workspace modes with paths containing spaces", async () => {
    const cwd = directory();
    const root = join(cwd, "project");
    mkdirSync(root);
    const git = (path: string, args: string[]) =>
      execFileSync("git", ["-C", path, ...args], { encoding: "utf8", windowsHide: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Windows Spike"]);
    writeFileSync(join(root, "file.txt"), "base\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    const tree = join(cwd, "existing tree");
    git(root, ["worktree", "add", "-q", "-b", "feature", tree]);
    const catalog = await listProjectWorkspaces(root);
    expect(catalog.ok).toBe(true);
    const selections: RunWorkspaceSelection[] = [
      { mode: "project" },
      { mode: "existing-worktree", path: tree },
      { mode: "new-worktree" },
    ];
    for (const [index, selection] of selections.entries()) {
      const request = {
        dataDir: join(cwd, `data-${index}`),
        projectId: "project",
        runId: "run-windows",
        path: "agent" as Path,
        attempt: 1,
        generation: 1,
        projectRoot: root,
        runWorkspace: { projectRoot: root, selection },
      };
      const first = await acquireScratch(request);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) continue;
      const workspace = first.value;
      expect(existsSync(join(workspace.dir, "file.txt"))).toBe(true);
      const finalized = await finalizeScratch(workspace, {
        outcome: "success",
        process: { attempt: 1, generation: 1, stopped: true, reason: "exited", exitCode: 0 },
      });
      expect(finalized.ok, JSON.stringify(finalized)).toBe(true);
      releaseScratch(workspace);
      const resumed = await acquireScratch({ ...request, requireExisting: true, generation: 2 });
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
      if (resumed.ok) {
        expect(resumed.value.dir).toBe(workspace.dir);
        releaseScratch(resumed.value);
      }
    }
  }, 40000);
  it("preserves argv through an npm cmd shim without shell expansion", async () => {
    const cwd = directory();
    writeFileSync(join(cwd, "agent.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(cwd, "agent.cmd"), '@echo off\r\nnode "%~dp0agent.js" %*\r\n');
    const args = [
      "",
      "spaces and Unicode 日本語",
      'a"b',
      "ends\\",
      "& echo injected | cmd",
      "%PATH%",
      "a\nb",
      "!^<>()",
    ];
    const result = await runCommand(
      { cmd: join(cwd, "agent.cmd"), args, cwd, env: env(), timeoutMs: 10000 },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  }, 20000);

  it("quotes interpolated values as PowerShell data and rejects unsafe contexts", async () => {
    const cwd = directory();
    const value = "a'; Write-Output INJECTED; # 日本語\nnext & %PATH%";
    const rendered = await renderTemplate(
      "Write-Output {{ start.value }}",
      { start: { value } },
      { shell: true, shellStyle: "powershell", executor: createNodeExpressionExecutor() },
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const result = await runCommand(
      { cmd: rendered.value.text, shell: true, cwd, env: env(), timeoutMs: 10000 },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().replaceAll("\r\n", "\n")).toBe(value);
    for (const template of [
      "<#\n{{ start.value }}\n#>",
      "Write-Output --% {{ start.value }}",
      "Write-Output ` {{ start.value }}",
    ]) {
      expect(
        (
          await renderTemplate(
            template,
            { start: { value } },
            { shell: true, shellStyle: "powershell" },
          )
        ).ok,
      ).toBe(false);
    }
  }, 20000);

  it("cancels all descendants while leaving an unrelated process alive", async () => {
    const cwd = directory();
    const marker = join(cwd, "pids.json");
    const script = join(cwd, "tree.cjs");
    writeFileSync(
      script,
      `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])); console.log('ready');setInterval(()=>{},1000);`,
    );
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    children.push(unrelated);
    const controller = new AbortController();
    const result = await runCommand(
      { cmd: process.execPath, args: [script], cwd, env: env(), timeoutMs: 15000 },
      {
        onStdout: (text) => {
          if (text.includes("ready")) controller.abort();
        },
      },
      controller.signal,
    );
    expect(result.killedBy).toBe("cancel");
    expect(result.groupStopped).toBe(true);
    const pids = JSON.parse(readFileSync(marker, "utf8")) as number[];
    await waitUntil(() => pids.every((pid) => !alive(pid)));
    expect(alive(unrelated.pid as number)).toBe(true);
  }, 30000);

  it("closes owned jobs when the supervising Node process crashes", async () => {
    const cwd = directory();
    const marker = join(cwd, "crash-pids.json");
    const worker = join(cwd, "worker.mjs");
    const adapterUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../adapters/dist/index.js"),
    ).href;
    const body = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    writeFileSync(
      worker,
      `import {runCommand,buildChildEnv} from ${JSON.stringify(adapterUrl)};await runCommand({cmd:process.execPath,args:['-e',${JSON.stringify(body)}],cwd:process.cwd(),env:buildChildEnv('fake'),timeoutMs:60000},{});`,
    );
    const parent = spawn(process.execPath, [worker], { cwd, stdio: "ignore", windowsHide: true });
    children.push(parent);
    await waitUntil(() => existsSync(marker));
    const pids = JSON.parse(readFileSync(marker, "utf8")) as number[];
    parent.kill("SIGKILL");
    await waitUntil(() => pids.every((pid) => !alive(pid)));
  }, 30000);

  it("refuses to kill a process with a different recorded creation time", async () => {
    const identity = await readProcessIdentity(process.pid);
    expect(identity?.pidStart).toMatch(/^windows:\d+$/);
    if (identity === null) return;
    expect(await killOrphan({ ...identity, pidStart: `${identity.pidStart}0` })).toEqual({
      matched: false,
      killed: false,
    });
    expect(alive(process.pid)).toBe(true);
  });

  it("persists isolated credential refresh and detects conflicting external edits", async () => {
    const cwd = directory();
    const canonical = join(cwd, "auth.json");
    const isolated = join(cwd, "exec", "auth.json");
    writeFileSync(canonical, '{"token":"old"}');
    const invocation = {
      bin: process.execPath,
      args: [],
      cwd,
      env: env(),
      files: [{ path: isolated, symlink: canonical }],
    };
    await materializeInvocation(invocation);
    writeFileSync(isolated, '{"token":"refreshed"}');
    await finalizeInvocation(invocation);
    expect(readFileSync(canonical, "utf8")).toBe('{"token":"refreshed"}');
    await materializeInvocation(invocation);
    writeFileSync(isolated, '{"token":"isolated"}');
    writeFileSync(canonical, '{"token":"external"}');
    await expect(finalizeInvocation(invocation)).rejects.toMatchObject({ code: "E_CONFLICT" });
    expect(readFileSync(canonical, "utf8")).toBe('{"token":"external"}');
  });

  it("runs a fake agent through MCP, SQLite and a native PowerShell shell step", () => {
    const cwd = directory();
    const value = "native Windows O'Brien 日本語";
    const script = join(cwd, "fake.json");
    writeFileSync(script, JSON.stringify([{ type: "submit", output: { value } }]));
    writeFileSync(
      join(cwd, "workflow.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "windows-smoke",
        name: "Windows smoke",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            {
              id: "agent",
              type: "agent",
              name: "Agent",
              cli: "fake",
              prompt: "submit",
              output: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              permissions: { network: false, write: ["workspace"] },
              limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 },
            },
            {
              id: "shell",
              type: "shell",
              name: "Shell",
              command: "Write-Output {{ agent.value }}",
              timeoutMin: 1,
            },
            {
              id: "end",
              type: "end",
              name: "End",
              status: "success",
              result: '{"value": agent.value}',
            },
          ],
          edges: [
            { id: "a", from: "start", to: "agent" },
            { id: "b", from: "agent", to: "shell" },
            { id: "c", from: "shell", to: "end" },
          ],
        },
      }),
    );
    const result = cli(
      [
        "run",
        "workflow.json",
        "--project",
        cwd,
        "--data-dir",
        join(cwd, "data"),
        "--fake-script",
        script,
        "--json",
      ],
      cwd,
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('"status":"succeeded"');
    expect(result.stdout).toContain(value);
  }, 40000);
});
