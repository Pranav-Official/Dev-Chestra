import type { RelayError, Result } from "@relay/core";

export type CliId = "claude-code" | "codex" | "fake";

export interface AdapterCaps {
  enforcesPermissions: "enforced" | "partial" | "advisory";
  structuredOutputFlag: boolean;
  resumeSupportsMcp: boolean;
  reportsCost: boolean;
  usageIsCumulative: boolean;
  promptViaStdin: boolean;
  maxPromptArgBytes: number;
}

export interface AdapterEvidence {
  cliVersion: string;
  argvSource: "help-fixture" | "synthetic";
  behaviorVerified: boolean;
  notes: readonly string[];
}

export interface RunPermissions {
  network: boolean;
  write: ("workspace" | "project")[];
  extraReadDirs: string[];
}

export interface McpConfig {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  envNames?: string[];
}

export interface RunRequest {
  mode: "fresh" | "resume";
  sessionId?: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissions: RunPermissions;
  limits: { timeoutMs: number; maxTurns?: number };
  mcp: McpConfig;
  cliOptions?: Record<string, unknown>;
  execDir: string;
  env: Record<string, string>;
}

export interface InvocationFile {
  path: string;
  content: string;
  mode?: number;
}

export interface Invocation {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  files: InvocationFile[];
}

export type AdapterEvent =
  | { t: "session"; sessionId: string }
  | { t: "text"; role: "assistant" | "system"; text: string }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; ok: boolean; summary: string }
  | { t: "usage"; tokensIn?: number; tokensOut?: number; costUsd?: number; cumulative: boolean }
  | { t: "turn_end"; isError: boolean; text?: string }
  | { t: "notice"; level: "info" | "warn"; text: string }
  | { t: "raw"; line: string };

export interface StreamParser {
  feed(chunk: Buffer): AdapterEvent[];
  end(): AdapterEvent[];
}

export type FailureClass =
  | { kind: "ok" }
  | { kind: "rate_limit"; retryAfterMs?: number }
  | { kind: "quota_window"; resumeAt?: number; source: "parsed" | "estimated" }
  | { kind: "credits" }
  | { kind: "auth" }
  | { kind: "cli_missing" }
  | { kind: "context_overflow" }
  | { kind: "crash"; exitCode: number | null; signal: string | null }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface Tail {
  stderr: string;
  stdout: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  killedBy: "timeout" | "cancel" | "watchdog" | null;
  durationMs: number;
  pid: number;
  stdoutBytes: number;
  stderrBytes: number;
  sawTurnEnd: boolean;
  /** False means at least one process in the group was still alive after SIGKILL grace. */
  groupStopped: boolean;
  tail: Tail;
}

export interface ProbeCtx {
  bin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  version: string | null;
  detail?: string;
}

export interface CliAdapter {
  readonly id: CliId;
  readonly caps: AdapterCaps;
  readonly evidence: AdapterEvidence;
  probe(ctx: ProbeCtx, signal: AbortSignal): Promise<ProbeResult>;
  plan(req: RunRequest): Result<Invocation, RelayError>;
  parser(): StreamParser;
  classify(exit: ExitInfo, tail: Tail): FailureClass;
  toolRef(tool: string): string;
}

export interface ProcessIdentity {
  pid: number;
  /** Canonical: linux:<boot_id>:<start_ticks> or darwin:<lstart>. */
  pidStart: string;
  /** Executable actually observed at pidStart; never a full argv string. */
  binary: string;
}

export interface SpawnIdentity extends ProcessIdentity {
  /** Alias of binary, for callers that persist a "bin" column. */
  bin: string;
  pgid: number;
  cwd: string;
  generation: number;
}

export type TranscriptKind =
  | "text"
  | "tool"
  | "tool_result"
  | "stderr"
  | "notice"
  | "raw"
  | "system";

export interface TranscriptEntry {
  ts: string;
  kind: TranscriptKind;
  text: string;
}

export interface RunOpts {
  parser: StreamParser;
  timeoutMs: number;
  silenceMs?: number;
  graceMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  maxStdoutTailBytes?: number;
  generation?: number;
}

export interface RunHooks {
  /** Awaited before stdin is written/closed. Persist here to close the spawn-persist gap. */
  onSpawn?: (identity: SpawnIdentity) => void | Promise<void>;
  onEvent?: (event: AdapterEvent) => void | Promise<void>;
  onStderr?: (chunk: string) => void;
  onWatchdog?: (kind: "silence" | "repeat", detail: string) => void;
  onTranscript?: (entry: TranscriptEntry) => void | Promise<void>;
  redact?: (text: string) => string;
}

export interface CommandRequest {
  cmd: string;
  args?: string[];
  shell?: boolean;
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface CommandHooks {
  /** Awaited before the wrapper releases the command. */
  onSpawn?: (identity: SpawnIdentity) => void | Promise<void>;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void;
  redact?: (text: string) => string;
  generation?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  killedBy: "timeout" | "cancel" | null;
  durationMs: number;
  pid: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  groupStopped: boolean;
}

export interface AdapterOptions {
  claudeBin?: string;
  codexBin?: string;
  fakeAgentBin?: string;
  nodeBin?: string;
}

export type CodexModelSource = "codex-app-server";

export interface CodexModelItem {
  /** Raw RPC `model` field: the exact value passed to `-m`. */
  id: string;
  label: string;
  /** Only present when the RPC actually reported it. */
  provider?: string;
  description?: string;
  /** Only RPC-reported aliases; never invented. */
  aliases?: string[];
  isDefault?: boolean;
  source: CodexModelSource;
}

export type CodexModelDiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";

export interface CodexModelDiscovery {
  status: CodexModelDiscoveryStatus;
  items: CodexModelItem[];
  cliVersion: string | null;
  truncated: boolean;
  /** Short canned text only; never raw stdout/stderr, env or provider messages. */
  message?: string;
}

export interface CodexModelDiscoveryRequest {
  /** Neutral runtime cwd owned by the composition root, matching execution scope. */
  cwd: string;
  /** Trusted binary from composition; defaults to `codex`. */
  bin?: string;
  /** Already allowlisted child environment. Never modified here. */
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Total bound. Clamped to 15s. */
  timeoutMs?: number;
  /** Trusted test/composition bounds below the documented maxima. */
  initTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxPages?: number;
  maxModels?: number;
  graceMs?: number;
}

export type ClaudeModelSource = "claude-sdk";

export interface ClaudeModelItem {
  /** Exact `ModelInfo.value` reported by the CLI initialize response; the value to pass as the model arg. */
  id: string;
  /** `ModelInfo.displayName`; falls back to the exact id when the CLI omits it. */
  label: string;
  description?: string;
  /** Only present when the initialize row actually reported it. */
  provider?: string;
  /** Only reported aliases; never inferred from `resolvedModel` or a static table. */
  aliases?: string[];
  isDefault?: boolean;
  source: ClaudeModelSource;
}

export type ClaudeModelDiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";

export interface ClaudeModelDiscovery {
  status: ClaudeModelDiscoveryStatus;
  items: ClaudeModelItem[];
  cliVersion: string | null;
  truncated: boolean;
  /** Short canned text only; never raw stdout/stderr, env, config or provider messages. */
  message?: string;
}

export interface ClaudeModelDiscoveryRequest {
  /** Neutral runtime cwd owned by the composition root. */
  cwd: string;
  /** Trusted installed Claude Code executable. Resolved from `env.PATH` when omitted. */
  bin?: string;
  /** Already allowlisted child environment. Never modified here. */
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Total bound. Clamped to 15s. */
  timeoutMs?: number;
  /** Trusted test/composition bounds below the documented maxima. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxModels?: number;
  graceMs?: number;
}

export interface AdapterRegistry {
  get(id: CliId): CliAdapter;
  has(id: CliId): boolean;
  ids(): CliId[];
}

export interface BuildEnvOptions {
  base?: NodeJS.ProcessEnv;
  nodeEnv?: Record<string, string>;
  nodeEnvNames?: readonly string[];
  cliEnv?: Record<string, string>;
  injected?: Record<string, string>;
  extraNames?: readonly string[];
}
