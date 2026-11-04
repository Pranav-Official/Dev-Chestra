import type { Issue, ShellPolicy } from "./types.js";
import { issue } from "./validate-support.js";

/**
 * Per-agent shell command policy: regex allowlist/denylist over the canonical
 * command line, plus per-command resource caps. Pure and browser-safe: no Node
 * builtins, only `RegExp` and `TextEncoder` (both available in browsers and the
 * CSP-jitless Web Worker).
 *
 * The evaluator input is the raw string the model sends. Tokenization resolves
 * POSIX words (single/double quotes, backslash) and rejects everything that
 * would need a real shell: compounds, redirects, substitution, globbing,
 * comments, `~`/`!` expansion and `VAR=value` prefixes. The gateway runs
 * `spawn(argv)` with no shell, so quoting is the only syntax and nothing
 * expands. `argv[0]` must not contain `/` (resolved through the sanitized PATH
 * only). The canonical command is the tokens joined by one space; policy
 * regexes run against it wrapped as `^(?:...)$`.
 */

/** Longest single policy pattern in characters. */
export const SHELL_POLICY_MAX_PATTERN_LENGTH = 512;
/** Most allow+deny rules combined. */
export const SHELL_POLICY_MAX_RULES = 50;
/** Longest model-sent command in UTF-8 bytes, checked before tokenizing. */
export const SHELL_POLICY_MAX_COMMAND_BYTES = 4096;
/** Smallest/largest per-command timeout in seconds. */
export const SHELL_POLICY_TIMEOUT_SEC_MIN = 1;
export const SHELL_POLICY_TIMEOUT_SEC_MAX = 3600;
/** Smallest/largest per-command output cap in bytes. */
export const SHELL_POLICY_MAX_OUTPUT_BYTES_MIN = 1;
export const SHELL_POLICY_MAX_OUTPUT_BYTES_MAX = 4194304;

/** One semantic problem, with a path relative to the `shellPolicy` object. */
export interface ShellPolicyProblem {
  path: string;
  message: string;
}

/**
 * Heuristic for obvious nested-quantifier ReDoS shapes such as `(a+)+`,
 * `(.*a)+` or `(?:\d+)*`. Escapes and character classes are stripped first so
 * `\+` and `[+]+` do not count. Conservative by design: alternation overlap
 * like `(a|aa)+` is out of scope.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const unescaped = pattern.replace(/\\./g, "");
  const noClasses = unescaped.replace(/\[[^\]]*\]/g, "");
  return /\((?:\?[:=!A-Za-z_-]*)?[^()]*?(?:[+*]|\{\d[^}]*\})[^()]*\)(?:[+*?]|\{\d)/.test(noClasses);
}

/**
 * Browser-safe semantic checks for a `shellPolicy` value. Returns problems
 * with paths relative to the policy object (`""`, `"/allow"`, `"/allow/0"`,
 * `"/timeoutSec"`, ...); callers prefix the node pointer and report each as
 * `E_SHELL_POLICY`. `undefined` (absent policy) has no problems.
 */
export function validateShellPolicy(policy: unknown): ShellPolicyProblem[] {
  if (policy === undefined) return [];
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return [{ path: "", message: "shellPolicy must be an object." }];
  }
  const problems: ShellPolicyProblem[] = [];
  const record = policy as Record<string, unknown>;
  const lists: Array<readonly [string, unknown]> = [
    ["allow", record.allow],
    ["deny", record.deny],
  ];
  for (const [field, value] of lists) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      problems.push({
        path: `/${field}`,
        message: `shellPolicy.${field} must be an array of regex strings.`,
      });
      continue;
    }
    for (let index = 0; index < value.length; index += 1) {
      const pattern: unknown = value[index];
      const path = `/${field}/${index}`;
      if (typeof pattern !== "string") {
        problems.push({ path, message: `shellPolicy.${field}[${index}] must be a string.` });
        continue;
      }
      if (pattern.length > SHELL_POLICY_MAX_PATTERN_LENGTH) {
        problems.push({
          path,
          message: `shellPolicy.${field}[${index}] is ${pattern.length} characters; the limit is ${SHELL_POLICY_MAX_PATTERN_LENGTH}.`,
        });
        continue;
      }
      try {
        new RegExp(pattern);
      } catch {
        problems.push({
          path,
          message: `shellPolicy.${field}[${index}] does not compile as a JavaScript RegExp.`,
        });
        continue;
      }
      if (hasNestedQuantifier(pattern)) {
        problems.push({
          path,
          message: `shellPolicy.${field}[${index}] looks like nested-quantifier ReDoS (for example '(a+)+'); rewrite it.`,
        });
      }
    }
  }
  const allowCount = Array.isArray(record.allow) ? record.allow.length : 0;
  const denyCount = Array.isArray(record.deny) ? record.deny.length : 0;
  if (allowCount + denyCount > SHELL_POLICY_MAX_RULES) {
    problems.push({
      path: "",
      message: `shellPolicy has ${allowCount + denyCount} rules; the limit is ${SHELL_POLICY_MAX_RULES}.`,
    });
  }
  const timeoutSec: unknown = record.timeoutSec;
  if (
    timeoutSec !== undefined &&
    (typeof timeoutSec !== "number" ||
      !Number.isSafeInteger(timeoutSec) ||
      timeoutSec < SHELL_POLICY_TIMEOUT_SEC_MIN ||
      timeoutSec > SHELL_POLICY_TIMEOUT_SEC_MAX)
  ) {
    problems.push({
      path: "/timeoutSec",
      message: `shellPolicy.timeoutSec must be an integer between ${SHELL_POLICY_TIMEOUT_SEC_MIN} and ${SHELL_POLICY_TIMEOUT_SEC_MAX} seconds.`,
    });
  }
  const maxOutputBytes: unknown = record.maxOutputBytes;
  if (
    maxOutputBytes !== undefined &&
    (typeof maxOutputBytes !== "number" ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < SHELL_POLICY_MAX_OUTPUT_BYTES_MIN ||
      maxOutputBytes > SHELL_POLICY_MAX_OUTPUT_BYTES_MAX)
  ) {
    problems.push({
      path: "/maxOutputBytes",
      message: `shellPolicy.maxOutputBytes must be an integer between ${SHELL_POLICY_MAX_OUTPUT_BYTES_MIN} and ${SHELL_POLICY_MAX_OUTPUT_BYTES_MAX} bytes.`,
    });
  }
  return problems;
}

/**
 * Full permissions-level check: `shell: false` with any policy is rejected,
 * then every `validateShellPolicy` problem becomes an `E_SHELL_POLICY` issue
 * under `${pointerBase}/shellPolicy`. `shell` omitted with a valid policy is
 * fine (treated as enabled).
 */
export function shellPolicyIssues(
  permissions: { shell?: boolean; shellPolicy?: ShellPolicy },
  pointerBase: string,
  nodeId: string | undefined,
): Issue[] {
  const found: Issue[] = [];
  if (permissions.shell === false && permissions.shellPolicy !== undefined) {
    found.push(
      issue(
        "error",
        "E_SHELL_POLICY",
        "permissions.shellPolicy requires shell to be enabled; omit shell or set it to true.",
        `${pointerBase}/shellPolicy`,
        nodeId,
      ),
    );
  }
  for (const problem of validateShellPolicy(permissions.shellPolicy)) {
    found.push(
      issue(
        "error",
        "E_SHELL_POLICY",
        problem.message,
        `${pointerBase}/shellPolicy${problem.path}`,
        nodeId,
      ),
    );
  }
  return found;
}

/**
 * Normalize a policy for hashing: stable ordering and dedupe of allow/deny
 * (like `write`), optional limits preserved as-is. Presence is preserved: an
 * explicitly empty `allow` stays `[]` (still denylist/plain semantics).
 */
export function normalizeShellPolicy(policy: ShellPolicy): ShellPolicy {
  const out: ShellPolicy = {};
  if (policy.allow !== undefined) out.allow = [...new Set(policy.allow)].sort();
  if (policy.deny !== undefined) out.deny = [...new Set(policy.deny)].sort();
  if (policy.timeoutSec !== undefined) out.timeoutSec = policy.timeoutSec;
  if (policy.maxOutputBytes !== undefined) out.maxOutputBytes = policy.maxOutputBytes;
  return out;
}

export type TokenizeOk = { ok: true; argv: string[] };
export type TokenizeErr = { ok: false; reason: string };
export type TokenizeResult = TokenizeOk | TokenizeErr;

const UNQUOTED_REJECTED = new Set([
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "*",
  "?",
  "~",
  "!",
]);

function rejectedReason(char: string): string {
  if (char === "#") return "command must not contain unquoted '#' (no comments).";
  return `command must not contain unquoted '${char}' (no compounds, redirects, globbing or expansion).`;
}

/**
 * POSIX word tokenization: single/double quotes and backslash resolve into
 * words; whitespace separates them. Rejects unquoted shell metacharacters,
 * newlines, `#`, and `$`/backtick anywhere (even quoted or backslash-escaped,
 * since there is no shell to give them meaning). Returns the argv words or a
 * human-readable reason.
 */
export function tokenizeShellCommand(command: string): TokenizeResult {
  const fail = (reason: string): TokenizeErr => ({ ok: false, reason });
  const words: string[] = [];
  let current = "";
  let started = false;
  let single = false;
  let double = false;
  const pushWord = (): void => {
    if (started) {
      words.push(current);
      current = "";
      started = false;
    }
  };
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === undefined) break;
    if (single) {
      if (char === "'") {
        single = false;
        index += 1;
        continue;
      }
      if (char === "\n" || char === "\r") return fail("command must not contain newlines.");
      if (char === "$" || char === "`") {
        return fail("command must not contain '$' or backticks (no expansion or substitution).");
      }
      current += char;
      started = true;
      index += 1;
      continue;
    }
    if (double) {
      if (char === '"') {
        double = false;
        index += 1;
        continue;
      }
      if (char === "\n" || char === "\r") return fail("command must not contain newlines.");
      if (char === "$" || char === "`") {
        return fail("command must not contain '$' or backticks (no expansion or substitution).");
      }
      if (char === "\\") {
        const next = command[index + 1];
        if (next === undefined) return fail("command ends with a trailing backslash.");
        if (next === "\n" || next === "\r") return fail("command must not contain newlines.");
        if (next === "$" || next === "`") {
          return fail("command must not contain '$' or backticks (no expansion or substitution).");
        }
        current += next;
        started = true;
        index += 2;
        continue;
      }
      current += char;
      started = true;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t") {
      pushWord();
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") return fail("command must not contain newlines.");
    if (char === "'") {
      single = true;
      started = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      double = true;
      started = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === undefined) return fail("command ends with a trailing backslash.");
      if (next === "\n" || next === "\r") return fail("command must not contain newlines.");
      if (next === "$" || next === "`") {
        return fail("command must not contain '$' or backticks (no expansion or substitution).");
      }
      current += next;
      started = true;
      index += 2;
      continue;
    }
    if (char === "$" || char === "`") {
      return fail("command must not contain '$' or backticks (no expansion or substitution).");
    }
    if (char === "#" || UNQUOTED_REJECTED.has(char)) return fail(rejectedReason(char));
    current += char;
    started = true;
    index += 1;
  }
  if (single) return fail("command has an unterminated single quote.");
  if (double) return fail("command has an unterminated double quote.");
  pushWord();
  if (words.length === 0) return fail("command is empty.");
  return { ok: true, argv: words };
}

const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

function matchRule(pattern: string, canonical: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(canonical);
  } catch {
    // Validation rejects non-compiling patterns; never match closed here.
    return false;
  }
}

export type ShellPolicyDecision =
  | { allow: true; argv: string[] }
  | { allow: false; reason: string; rule?: string };

/**
 * Evaluate a policy against a raw command. Deny rules run first; a non-empty
 * `allow` is an allowlist (anything unmatched is denied), otherwise a denylist
 * (or plain parsed shell when the policy is absent/empty). The command is
 * capped at 4 KiB in UTF-8 bytes before tokenizing, and parsing still applies
 * with no policy.
 */
export function evaluateShellPolicy(
  policy: ShellPolicy | undefined,
  command: string,
): ShellPolicyDecision {
  if (new TextEncoder().encode(command).length > SHELL_POLICY_MAX_COMMAND_BYTES) {
    return {
      allow: false,
      reason: `command exceeds the ${SHELL_POLICY_MAX_COMMAND_BYTES}-byte limit.`,
    };
  }
  const tokenized = tokenizeShellCommand(command);
  if (!tokenized.ok) return { allow: false, reason: tokenized.reason };
  const argv = tokenized.argv;
  const program = argv[0];
  if (program === undefined || program === "") return { allow: false, reason: "command is empty." };
  if (program.includes("/")) {
    return {
      allow: false,
      reason: `program '${program}' must not contain '/' (resolved through the sanitized PATH only).`,
    };
  }
  if (ENV_PREFIX.test(program)) {
    return {
      allow: false,
      reason: `command must not set environment variables ('${program}').`,
    };
  }
  const canonical = argv.join(" ");
  for (const rule of policy?.deny ?? []) {
    if (matchRule(rule, canonical)) {
      return { allow: false, reason: `command matched deny rule "${rule}".`, rule };
    }
  }
  const allow = policy?.allow ?? [];
  if (allow.length > 0) {
    for (const rule of allow) {
      if (matchRule(rule, canonical)) return { allow: true, argv };
    }
    return { allow: false, reason: "command matched no allow rule." };
  }
  return { allow: true, argv };
}
