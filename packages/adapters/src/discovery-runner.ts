import { runCommand } from "./command.js";
import { boundCount, boundMs, validateDiscoveryRequest } from "./discovery-util.js";
import type { CommandResult } from "./types.js";

export interface DiscoveryRunnerRequest {
  cwd: string;
  bin?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxModels?: number;
}

export interface DiscoveryRunnerLimits {
  totalMs: number;
  stdoutMax: number;
  stderrMax: number;
  modelsMax: number;
}

export interface DiscoveryRunnerMessages {
  invalidRequest: string;
  missing: string;
  unavailable: string;
  timeout: string;
  cancelled: string;
}

export interface DiscoveryRun<TItem> {
  result: CommandResult;
  stdout: string;
  stdoutBytes: number;
  combined: string;
  parsed: { items: TItem[]; truncated: boolean };
  maxModels: number;
  maxStdout: number;
  cliVersion: string | null;
}

export interface DiscoveryRunnerSpec<TItem, TResult> {
  request: DiscoveryRunnerRequest;
  limits: DiscoveryRunnerLimits;
  messages: DiscoveryRunnerMessages;
  /**Message for a pre-aborted signal. Drift: pi reuses invalidRequest, opencode uses cancelled.*/
  abortedMessage: string;
  resolveBin: () => string | null;
  buildArgs: () => string[];
  /**Optional pre-list probe (pi --version). A throw resolves to null; the version threads into failures.*/
  probeCliVersion?: (ctx: {
    bin: string;
    cwd: string;
    env: Record<string, string>;
    signal?: AbortSignal;
    remaining: () => number;
  }) => Promise<string | null>;
  parse: (stdout: string) => { items: TItem[]; truncated: boolean };
  /**Maps a runCommand throw to a failure message. Kept per-CLI: the catch branches drifted.*/
  classifyCaughtError: (error: unknown) => string;
  /**Per-CLI decision tree over the completed run: auth / nonzero-exit / oversize / success.*/
  interpret: (run: DiscoveryRun<TItem>) => TResult;
  fail: (status: string, message: string, cliVersion: string | null) => TResult;
}

/**
 * Shared "run CLI, cap output, hand the stdout to a parser" skeleton for
 * model discovery. Only the spawn/timeout/cap envelope is shared; parsers
 * and the per-CLI result decision trees stay in the callers.
 */
export async function runModelDiscovery<TItem, TResult>(
  spec: DiscoveryRunnerSpec<TItem, TResult>,
): Promise<TResult> {
  const { request, limits, messages } = spec;
  if (typeof request !== "object" || request === null || !validateDiscoveryRequest(request)) {
    return spec.fail("unavailable", messages.invalidRequest, null);
  }
  if (request.signal?.aborted === true) {
    return spec.fail("unavailable", spec.abortedMessage, null);
  }
  const totalMs = boundMs(request.timeoutMs, limits.totalMs);
  const maxStdout = boundCount(request.maxStdoutBytes, limits.stdoutMax);
  const maxStderr = boundCount(request.maxStderrBytes, limits.stderrMax);
  const maxModels = boundCount(request.maxModels, limits.modelsMax);
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, totalMs - (Date.now() - startedAt));
  const bin = spec.resolveBin();
  if (bin === null) return spec.fail("unavailable", messages.missing, null);

  let cliVersion: string | null = null;
  try {
    cliVersion =
      (await spec.probeCliVersion?.({
        bin,
        cwd: request.cwd,
        env: request.env,
        signal: request.signal,
        remaining,
      })) ?? null;
  } catch {
    cliVersion = null;
  }

  let result: CommandResult;
  try {
    result = await runCommand(
      {
        cmd: bin,
        args: spec.buildArgs(),
        cwd: request.cwd,
        env: { ...request.env },
        timeoutMs: remaining(),
        maxStdoutBytes: maxStdout,
        maxStderrBytes: maxStderr,
      },
      {},
      request.signal,
    );
    if (result.killedBy === "timeout")
      return spec.fail("unavailable", messages.timeout, cliVersion);
    if (result.killedBy === "cancel")
      return spec.fail("unavailable", messages.cancelled, cliVersion);
  } catch (error) {
    return spec.fail("unavailable", spec.classifyCaughtError(error), cliVersion);
  }

  const stdout = result.stdout;
  return spec.interpret({
    result,
    stdout,
    stdoutBytes: result.stdoutBytes,
    combined: `${result.stdout}\n${result.stderr}`,
    parsed: spec.parse(stdout),
    maxModels,
    maxStdout,
    cliVersion,
  });
}
