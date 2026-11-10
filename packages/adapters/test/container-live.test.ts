import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import {
  type ContainerExecution,
  containerBaseEnv,
  containerRuntimeArgs,
  detectContainerRuntime,
  ensureCredentialVolume,
  recoverContainers,
  runtimeCommand,
  wrapContainerInvocation,
} from "../src/container.js";

const enabled = process.env.DEVCHESTRA_TEST_CONTAINER === "1";
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(): ContainerExecution {
  const root = mkdtempSync(join(tmpdir(), "dc-container-live-"));
  roots.push(root);
  mkdirSync(join(root, "clone"));
  return {
    runtime: detectContainerRuntime(root),
    dataDir: root,
    cwd: join(root, "clone"),
    runId: "live",
    executionId: "command",
  };
}
describe.skipIf(!enabled)("live container execution", () => {
  it("runs shell and argv commands in the image with a writable same-path mount", async () => {
    const spec = fixture();
    const env = containerBaseEnv({ CI: "1" });
    const result = await runCommand(
      {
        cmd: "printf container > result; printf '%s' \"$PWD\"",
        shell: true,
        cwd: spec.cwd,
        env,
        container: spec,
        timeoutMs: 30_000,
      },
      {},
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(spec.cwd);
    expect(result.groupStopped).toBe(true);
    expect(readFileSync(join(spec.cwd, "result"), "utf8")).toBe("container");
    const argv = await runCommand(
      {
        cmd: "node",
        args: ["-e", "console.log(process.env.HOME)"],
        cwd: spec.cwd,
        env,
        container: spec,
        timeoutMs: 30_000,
      },
      {},
    );
    expect(argv.exitCode).toBe(0);
    expect(argv.stdout.trim()).toBe("/home/devchestra");
    recoverContainers(spec.dataDir);
  }, 60_000);
  it("persists a dedicated home across containers and enforces a read-only workspace mount", async () => {
    const spec = fixture();
    const homeVolume = ensureCredentialVolume(spec.runtime, "test-home");
    try {
      const env = containerBaseEnv({});
      const write = await runCommand(
        {
          cmd: 'printf session > "$HOME/session"',
          shell: true,
          cwd: spec.cwd,
          env,
          container: { ...spec, homeVolume },
          timeoutMs: 30_000,
        },
        {},
      );
      expect(write.stderr).toBe("");
      expect(write.exitCode).toBe(0);
      const resumed = await runCommand(
        {
          cmd: 'cat "$HOME/session"; touch blocked',
          shell: true,
          cwd: spec.cwd,
          env,
          container: { ...spec, homeVolume, readOnlyWorkspace: true },
          timeoutMs: 30_000,
        },
        {},
      );
      expect(resumed.stdout).toBe("session");
      expect(resumed.exitCode).not.toBe(0);
      expect(existsSync(join(spec.cwd, "blocked"))).toBe(false);
    } finally {
      runtimeCommand(spec.runtime, ["volume", "rm", homeVolume]);
    }
  }, 60_000);
  it("stops the container on cancellation", async () => {
    const spec = fixture();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1500);
    const result = await runCommand(
      {
        cmd: "sleep 60; touch escaped",
        shell: true,
        cwd: spec.cwd,
        env: containerBaseEnv({}),
        container: spec,
        timeoutMs: 30_000,
      },
      {},
      abort.signal,
    );
    expect(result.killedBy).toBe("cancel");
    expect(result.groupStopped).toBe(true);
    expect(existsSync(join(spec.cwd, "escaped"))).toBe(false);
    recoverContainers(spec.dataDir);
  }, 30_000);
  it("authenticates HTTPS Git through gh using environment-only helper configuration", async () => {
    const spec = fixture();
    const token = "devchestra-offline-helper-sentinel";
    const env = {
      ...containerBaseEnv({}),
      GH_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    };
    const result = await runCommand(
      {
        cmd: "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
        shell: true,
        cwd: spec.cwd,
        env,
        container: spec,
        timeoutMs: 30_000,
      },
      { redact: (value) => value.split(token).join("[redacted]") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("password=[redacted]");
    expect(result.stdout).not.toContain(token);
  }, 30_000);
  it("recovers a detached orphan using its persisted ownership record", () => {
    const spec = fixture();
    const launch = wrapContainerInvocation(
      {
        bin: "/bin/sh",
        args: ["-c", "sleep 60"],
        cwd: spec.cwd,
        env: containerBaseEnv({}),
        files: [],
      },
      spec,
    );
    const args = [...launch.invocation.args];
    args.splice(args.indexOf("run") + 1, 0, "--detach");
    const id = runtimeCommand(launch.invocation.bin, args);
    recoverContainers(spec.dataDir);
    expect(readdirSync(join(spec.dataDir, "sandbox/containers"))).toEqual([]);
    expect(
      spawnSync(spec.runtime.bin, containerRuntimeArgs(spec.runtime, ["inspect", id]), {
        stdio: "ignore",
      }).status,
    ).not.toBe(0);
  }, 30_000);
});
