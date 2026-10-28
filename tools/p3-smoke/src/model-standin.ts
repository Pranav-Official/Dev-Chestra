import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT, sleep } from "./fixtures.js";

export interface ClaudeStandinControl {
  delayMs?: number;
  fail?: "none" | "error" | "methodNotFound" | "malformed" | "authRequired" | "exit" | "hang";
  nonce?: string;
}

export interface StandinControl {
  delayMs?: number;
  fail?: "none" | "methodNotFound" | "malformed" | "oversize" | "authRequired" | "exit1";
  pages?: Array<Array<Record<string, unknown>>>;
  pageCount?: number;
  claude?: ClaudeStandinControl;
}

export interface StandinLogEntry {
  at: number;
  as: string;
  pid: number;
  kind: "spawn" | "rpc" | "exit" | "invalid-json" | "stdin-frame" | "protocol-violation";
  mode?: "app-server" | "exec" | "version" | "sdk-discovery";
  method?: string;
  params?: unknown;
  argv?: string[];
  cwd?: string;
  home?: string | null;
  codexHome?: string | null;
  claudeHome?: string | null;
  model?: string | null;
  stdin?: string;
  stdinBytes?: number;
  forbiddenFrame?: boolean;
  frame?: Record<string, unknown>;
  reason?: string;
  nonce?: string;
  code?: number;
}

export interface SentinelFile {
  path: string;
  bytes: string;
}

export type ModelStandinCli = "codex" | "claude" | "opencode" | "pi";

export interface ModelStandin {
  binDir: string;
  env: Record<string, string>;
  controlPath: string;
  logPath: string;
  setControl(control: StandinControl): Promise<void>;
  resetControl(): Promise<void>;
  resetLog(): Promise<void>;
  readLog(): Promise<StandinLogEntry[]>;
  spawns(as?: ModelStandinCli): Promise<StandinLogEntry[]>;
  rpcs(as?: ModelStandinCli): Promise<StandinLogEntry[]>;
  execSpawns(as?: ModelStandinCli): Promise<StandinLogEntry[]>;
  discoverySpawns(as?: ModelStandinCli): Promise<StandinLogEntry[]>;
  frames(as?: ModelStandinCli): Promise<Record<string, unknown>[]>;
  violations(as?: ModelStandinCli): Promise<StandinLogEntry[]>;
  touchClaudeSettings(): Promise<void>;
  waitFor<T>(label: string, predicate: () => Promise<T | null>, timeoutMs?: number): Promise<T>;
  sentinels(): SentinelFile[];
  assertSentinelsUnchanged(): Promise<void>;
  assertNoLiveProcesses(): Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeWrapper(path: string, script: string, as: ModelStandinCli, control: string) {
  const body = [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} ${shellQuote(script)} --as ${as} --control ${shellQuote(control)} "$@"`,
    "",
  ].join("\n");
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

export async function installModelStandins(root: string): Promise<ModelStandin> {
  const binDir = join(root, "standin-bin");
  const dataDir = join(root, "standin-data");
  const home = join(dataDir, "home");
  const codexHome = join(dataDir, "codex-home");
  const claudeHome = join(dataDir, "claude-home");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(claudeHome, { recursive: true, mode: 0o700 });

  const sentinelFiles: SentinelFile[] = [
    { path: join(home, ".devchestra-sentinel"), bytes: "test-home-sentinel\n" },
    { path: join(codexHome, "config.toml"), bytes: 'model = "sentinel-test-only"\n' },
    { path: join(codexHome, "auth.json"), bytes: '{"token":"dummy-test-token"}\n' },
    { path: join(claudeHome, "settings.json"), bytes: '{"model":"sentinel-test-only"}\n' },
  ];
  for (const file of sentinelFiles) await writeFile(file.path, file.bytes, { mode: 0o600 });

  const script = join(REPO_ROOT, "tools/fixtures/model-selector/standin.mjs");
  await writeWrapper(join(binDir, "codex"), script, "codex", binDir);
  await writeWrapper(join(binDir, "claude"), script, "claude", binDir);
  await writeWrapper(join(binDir, "opencode"), script, "opencode", binDir);
  await writeWrapper(join(binDir, "pi"), script, "pi", binDir);
  const controlPath = join(binDir, "standin-control.json");
  const logPath = join(binDir, "standin-log.ndjson");
  await writeFile(controlPath, "{}\n", "utf8");

  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    ANTHROPIC_API_KEY: "dummy-anthropic-test-key",
    ANTHROPIC_AUTH_TOKEN: "dummy-anthropic-test-token",
    OPENAI_API_KEY: "dummy-openai-test-key",
    CODEX_API_KEY: "dummy-codex-test-key",
    OPENCODE_API_KEY: "dummy-opencode-test-key",
  };

  let control: StandinControl = {};
  const readLog = async (): Promise<StandinLogEntry[]> => {
    let text = "";
    try {
      text = await readFile(logPath, "utf8");
    } catch {
      return [];
    }
    const entries: StandinLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line) as StandinLogEntry);
      } catch {
        // A process may be mid-write; ignore the partial tail.
      }
    }
    return entries;
  };
  const filtered = async (
    as: ModelStandinCli | undefined,
    predicate: (e: StandinLogEntry) => boolean,
  ) =>
    (await readLog()).filter(
      (entry) => (as === undefined ? true : entry.as === as) && predicate(entry),
    );

  return {
    binDir,
    env,
    controlPath,
    logPath,
    async setControl(next) {
      control = { ...control, ...next };
      await writeFile(controlPath, `${JSON.stringify(control)}\n`, "utf8");
    },
    async resetControl() {
      control = {};
      await writeFile(controlPath, "{}\n", "utf8");
    },
    async resetLog() {
      await writeFile(logPath, "", "utf8");
    },
    readLog,
    spawns: (as) => filtered(as, (entry) => entry.kind === "spawn"),
    rpcs: (as) => filtered(as, (entry) => entry.kind === "rpc"),
    execSpawns: (as) => filtered(as, (entry) => entry.kind === "spawn" && entry.mode === "exec"),
    discoverySpawns: (as) =>
      filtered(as, (entry) => entry.kind === "spawn" && entry.mode === "sdk-discovery"),
    frames: async (as) =>
      (await filtered(as, (entry) => entry.kind === "stdin-frame"))
        .map((entry) => entry.frame)
        .filter((frame): frame is Record<string, unknown> => frame !== undefined),
    violations: (as) => filtered(as, (entry) => entry.kind === "protocol-violation"),
    async touchClaudeSettings() {
      const path = join(claudeHome, "settings.json");
      const info = await stat(path);
      const next = new Date(info.mtimeMs + 2_000);
      await utimes(path, next, next);
    },
    async waitFor(label, predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await predicate();
        if (value !== null) return value;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(50);
      }
    },
    sentinels: () => sentinelFiles,
    async assertSentinelsUnchanged() {
      for (const file of sentinelFiles) {
        assert.equal(
          await readFile(file.path, "utf8"),
          file.bytes,
          `stand-in sentinel changed: ${file.path}`,
        );
      }
    },
    async assertNoLiveProcesses() {
      const entries = await readLog();
      const pids = new Set(entries.filter((entry) => entry.kind === "spawn").map((e) => e.pid));
      for (const pid of pids) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        assert.equal(alive, false, `stand-in process ${String(pid)} survived cleanup`);
      }
    },
  };
}
