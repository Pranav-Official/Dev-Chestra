import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { runCommand } from "@devchestra/adapters";
import { evaluateShellPolicy, type ShellPolicy } from "@devchestra/schema";
import type { ExecShellScope, ExecToolEvent } from "./tokens.js";

/**
 * Gateway-side `exec` for policy agents. POSIX only: the win32 guard lives in
 * the caller so the policy never half-runs there. The command is evaluated by
 * the shared schema evaluator, resolved through the sanitized PATH, and spawned
 * as argv with no shell, a pinned cwd and the allowlisted child env.
 */

export const EXEC_TOOL_NAME = "exec";
/** Gateway grace above the policy deadline before the request controller aborts. */
export const EXEC_GRACE_MS = 10_000;
const DESCRIPTION_MAX_CHARS = 1_500;

export interface ExecOutcome {
  text: string;
  isError: boolean;
}

/** Absolute, non-empty PATH entries only. Relative entries (including "" and ".") are dropped. */
export function sanitizedPathDirs(pathValue: string | undefined): string[] {
  if (pathValue === undefined || pathValue === "") return [];
  return pathValue.split(delimiter).filter((entry) => entry !== "" && isAbsolute(entry));
}

/** Resolve a bare program name through the sanitized PATH. Returns null when no executable matches. */
export function resolveProgram(program: string, pathValue: string | undefined): string | null {
  if (program === "" || program.includes("/") || program.includes("\u0000")) return null;
  for (const dir of sanitizedPathDirs(pathValue)) {
    const candidate = join(dir, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here or not executable; keep looking.
    }
  }
  return null;
}

/** Tool description that tells the model exactly what it may run. */
export function execDescription(policy: ShellPolicy): string {
  const allow = policy.allow ?? [];
  const deny = policy.deny ?? [];
  const parts = [
    "Run one command (no shell). Pass the whole command line as a single string in `command`.",
    allow.length > 0
      ? `Allowed only if the canonical command matches one of: ${allow.join(" | ")}.`
      : "Any command is allowed unless a deny pattern matches.",
    deny.length > 0 ? `Always denied when it matches: ${deny.join(" | ")}.` : "",
    "Each call is stateless and runs in the fixed workspace directory; cd, pipes, redirects, globbing, $ expansion and command chaining are not supported.",
  ].filter((part) => part !== "");
  const text = parts.join(" ");
  return text.length > DESCRIPTION_MAX_CHARS
    ? `${text.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`
    : text;
}

export function execInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      command: { type: "string", description: "The full command line, e.g. rg TODO src" },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

function denialText(reason: string, policy: ShellPolicy): string {
  const allow = policy.allow ?? [];
  const allowed =
    allow.length > 0
      ? `Allowed patterns: ${allow.join(" | ")}`
      : "Allowed patterns: none (any command not matched by a deny rule)";
  return `Command denied by shell policy: ${reason}\n${allowed}`;
}

export interface RunExecInput {
  shell: ExecShellScope;
  command: string;
  signal: AbortSignal;
}

/** Evaluate the policy and run the command. Denials and failures are tool results, never run failures. */
export async function runPolicyExec(input: RunExecInput): Promise<ExecOutcome> {
  const { shell, command } = input;
  const emit = (event: ExecToolEvent): void => {
    try {
      shell.onToolEvent?.(event);
    } catch {
      // Transcript sinks are best-effort; a sink failure must not change the tool result.
    }
  };
  emit({ kind: "tool", text: `exec ${command}` });

  const decision = evaluateShellPolicy(shell.policy, command);
  if (!decision.allow) {
    const outcome = { text: denialText(decision.reason, shell.policy), isError: true };
    emit({ kind: "tool_result", text: `denied: ${decision.reason}` });
    return outcome;
  }

  const resolved = resolveProgram(decision.argv[0] ?? "", shell.env.PATH);
  if (resolved === null) {
    const message = `program '${decision.argv[0]}' was not found as an executable on the sanitized PATH.`;
    emit({ kind: "tool_result", text: `not run: ${message}` });
    return { text: `Command not run: ${message}`, isError: true };
  }

  let result: Awaited<ReturnType<typeof runCommand>>;
  try {
    result = await runCommand(
      {
        cmd: resolved,
        args: decision.argv.slice(1),
        shell: false,
        cwd: shell.cwd,
        env: shell.env,
        timeoutMs: shell.timeoutMs,
        maxStdoutBytes: shell.maxOutputBytes,
        maxStderrBytes: shell.maxOutputBytes,
      },
      {},
      input.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "command failed to start";
    emit({ kind: "tool_result", text: `failed to start: ${message}` });
    return { text: `Command failed to start: ${message}`, isError: true };
  }

  const status =
    result.killedBy === "timeout"
      ? `timed out after ${Math.round(shell.timeoutMs / 1000)}s and was killed`
      : result.killedBy === "cancel"
        ? "was cancelled and killed"
        : result.signal !== null
          ? `was terminated by signal ${result.signal}`
          : `exited with code ${result.exitCode ?? "unknown"}`;
  const lines = [`Command ${status}.`];
  if (result.stdout !== "" || result.stdoutBytes > 0) {
    const truncated =
      result.stdoutBytes > shell.maxOutputBytes
        ? ` [truncated: kept last ${shell.maxOutputBytes} of ${result.stdoutBytes} bytes]`
        : "";
    lines.push(`stdout${truncated}:`, result.stdout);
  }
  if (result.stderr !== "" || result.stderrBytes > 0) {
    const truncated =
      result.stderrBytes > shell.maxOutputBytes
        ? ` [truncated: kept last ${shell.maxOutputBytes} of ${result.stderrBytes} bytes]`
        : "";
    lines.push(`stderr${truncated}:`, result.stderr);
  }
  const text = lines.join("\n");
  const failed = result.killedBy !== null || result.exitCode !== 0 || result.signal !== null;
  emit({ kind: "tool_result", text });
  return { text, isError: failed };
}
