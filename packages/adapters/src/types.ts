import type { DevChestraError, Result } from "@devchestra/core";
import { isProdCliId, type ProdCliId, type ShellPolicy } from "@devchestra/schema";
import type { ContainerExecution } from "./container-types.js";

export type { ProdCliId };
export { isProdCliId };

/** Production CLI ids plus the test-only `fake` (behind DEVCHESTRA_ALLOW_FAKE). */
export type CliId = ProdCliId | "fake";

/** Type guard for {@link CliId}. Use it instead of casting CLI ids. */
export function isCliId(value: unknown): value is CliId {
  return isProdCliId(value) || value === "fake";
}

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
  /** Built-in shell tool. Undefined keeps the legacy rule: shell follows `write` being non-empty. */
  shell?: boolean;
  /**
   * Per-agent command policy enforced by the DevChestra `exec` tool. Setting it
   * disables the CLI's native shell in every adapter, exactly like `shell:false`,
   * regardless of `shell` (true/undefined), and CLI options can never re-enable it.
   */
  shellPolicy?: ShellPolicy;
  extraReadDirs: string[];
}

export interface McpConfig {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  envNames?: string[];
}

/** One extra MCP server resolved by the engine right before launch. May carry secrets: never log or persist. */
export interface ResolvedMcpServer {
  name: string;
  scope: "global" | "project" | "connector";
  transport: "stdio" | "http" | "sse";
  /** stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  /** Connectors only: id of the connector inside the CLI's built-in apps server. */
  connectorId?: string;
}

export interface RunRequest {
  container?: boolean;
  mode: "fresh" | "resume";
  sessionId?: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissions: RunPermissions;
  limits: { timeoutMs: number; maxTurns?: number };
  mcp: McpConfig;
  /** Servers the node switched on. Everything else the CLI knows about must stay off. */
  extraMcp?: ResolvedMcpServer[];
  /** Every server the CLI knows for this project (names only), so adapters can switch the unselected ones off. */
  knownMcp?: { name: string; scope: "global" | "project" | "connector"; connectorId?: string }[];
  cliOptions?: Record<string, unknown>;
  execDir: string;
  env: Record<string, string>;
}

export interface InvocationFile {
  path: string;
  /** File bytes; required unless `symlink` is set. */
  content?: string;
  mode?: number;
  /** When set, materialize a symlink at `path` pointing at this target
   * instead of writing `content`. Writes through the link persist back to
   * the canonical store (e.g. credential refresh). */
  symlink?: string;
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
  plan(req: RunRequest): Result<Invocation, DevChestraError>;
  /** Runtime planning with bounded CLI capability probes. Prefer this over plan when present. */
  planAsync?(req: RunRequest, signal: AbortSignal): Promise<Result<Invocation, DevChestraError>>;
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
  container?: ContainerExecution;
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
  container?: ContainerExecution;
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
  opencodeBin?: string;
  piBin?: string;
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

export type PiModelSource = "pi-list-models";

export interface PiModelItem {
  /** Provider-qualified `provider/model` id; the value to pass as `--model`
   * (with `--provider`). Bare only when the row carries no provider column. */
  id: string;
  /** Bare model column of the row; never the routing id. */
  label: string;
  /** Provider column of the same row; the value to pass as `--provider`. */
  provider?: string;
  source: PiModelSource;
}

export type PiModelDiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";

export interface PiModelDiscovery {
  status: PiModelDiscoveryStatus;
  items: PiModelItem[];
  cliVersion: string | null;
  truncated: boolean;
  /** Short canned text only; never raw stdout/stderr, env, config or provider messages. */
  message?: string;
}

export interface PiModelDiscoveryRequest {
  /** Neutral runtime cwd owned by the composition root. */
  cwd: string;
  /** Trusted installed Pi executable. Resolved from `env.PATH` when omitted. */
  bin?: string;
  /** Already allowlisted child environment. Never modified here. */
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Total bound. Clamped to 15s. */
  timeoutMs?: number;
  /** Optional fuzzy search passed as the positional `[search]` argument. */
  search?: string;
  /** Trusted test/composition bounds below the documented maxima. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxModels?: number;
}

export type OpencodeModelSource = "opencode-models";

export interface OpencodeModelItem {
  /** Exact `provider/model` line reported by `opencode models`; the value to pass as `-m`. */
  id: string;
  /** Verbose `name` when reported, else the exact id. */
  label: string;
  /** Prefix before the first `/`; only present when the id actually reported it. */
  provider?: string;
  source: OpencodeModelSource;
}

export type OpencodeModelDiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";

export interface OpencodeModelDiscovery {
  status: OpencodeModelDiscoveryStatus;
  items: OpencodeModelItem[];
  cliVersion: string | null;
  truncated: boolean;
  /** Short canned text only; never raw stdout/stderr, env, config or provider messages. */
  message?: string;
}

export interface OpencodeModelDiscoveryRequest {
  /** Neutral runtime cwd owned by the composition root. */
  cwd: string;
  /** Trusted installed opencode executable. Defaults to `opencode`. */
  bin?: string;
  /** Already allowlisted child environment. Never modified here. */
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Total bound. Clamped to 15s. */
  timeoutMs?: number;
  /** When true, run `models --verbose` and read `name` labels from it. */
  verbose?: boolean;
  /** Trusted test/composition bounds below the documented maxima. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxModels?: number;
}

export interface BuildEnvOptions {
  base?: NodeJS.ProcessEnv;
  nodeEnv?: Record<string, string>;
  nodeEnvNames?: readonly string[];
  cliEnv?: Record<string, string>;
  injected?: Record<string, string>;
  extraNames?: readonly string[];
}
