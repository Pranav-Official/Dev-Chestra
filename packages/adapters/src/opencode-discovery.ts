import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { runCommand } from "./command.js";
import {
  boundCount,
  boundMs,
  hasControl,
  printable,
  validateDiscoveryRequest,
} from "./discovery-util.js";
import type {
  OpencodeModelDiscovery,
  OpencodeModelDiscoveryRequest,
  OpencodeModelItem,
} from "./types.js";

const TOTAL_MS = 15_000;
const STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 64 * 1024;
const MODELS_MAX = 1000;
const ID_MAX = 256;
const LABEL_MAX = 256;
const PROVIDER_MAX = 128;

/** Only these basenames are ever statted for opencode context identity. */
const CONTEXT_FILES = ["opencode.json", "auth.json"] as const;

const MESSAGES = {
  invalidRequest: "Invalid model discovery request.",
  missing: "Opencode CLI was not found.",
  unsupported: "Opencode CLI does not support model discovery.",
  unavailable: "Opencode model discovery is unavailable.",
  oversize: "Opencode model output exceeded safe limits.",
  timeout: "Opencode model discovery timed out.",
  cancelled: "Opencode model discovery was cancelled.",
  authRequired: "Opencode requires authentication to list models.",
} as const;

function failure(
  status: OpencodeModelDiscovery["status"],
  message: string,
): OpencodeModelDiscovery {
  return { status, items: [], cliVersion: null, truncated: false, message };
}

function capped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;

function splitId(id: string): { provider: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  const provider = capped(printable(id.slice(0, slash)), PROVIDER_MAX);
  return provider === "" ? null : { provider };
}

/**
 * Parse `opencode models [--verbose]` stdout. Plain mode is one
 * `provider/model` id per line; verbose mode interleaves the same id lines
 * with pretty-printed JSON metadata blocks carrying a `name` label. The id
 * is always passed through exactly; labels never invent aliases.
 */
export function parseOpencodeModels(stdout: string): {
  items: OpencodeModelItem[];
  truncated: boolean;
} {
  const items: OpencodeModelItem[] = [];
  const labels = new Map<string, string>();
  const seen = new Set<string>();
  let truncated = false;
  let pending: string | null = null;

  const flush = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const split = splitId(id);
    const label = labels.get(id) ?? id;
    items.push({
      id,
      label: capped(label, LABEL_MAX),
      ...(split === null ? {} : { provider: split.provider }),
      source: "opencode-models",
    });
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("{") && ID_RE.test(trimmed) && !hasControl(trimmed)) {
      if (pending !== null) flush(pending);
      pending = capped(trimmed, ID_MAX);
      continue;
    }
    if (pending !== null && !labels.has(pending)) {
      const match = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed);
      if (match?.[1] !== undefined) {
        try {
          const name = capped(printable(JSON.parse(`"${match[1]}"`) as string), LABEL_MAX);
          if (name !== "") labels.set(pending, name);
        } catch {
          // Not a decodable name; the id stays its own label.
        }
      }
      continue;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith('"')) continue;
    truncated = true;
  }
  if (pending !== null) flush(pending);
  return { items, truncated };
}

function resolveOpencodeBin(
  bin: string | undefined,
  env: Record<string, string>,
  cwd: string,
): string | null {
  const name = bin ?? "opencode";
  if (name.includes("/") || isAbsolute(name)) {
    const candidate = isAbsolute(name) ? name : resolve(cwd, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = isAbsolute(entry) ? join(entry, name) : resolve(cwd, entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function configDir(env: Record<string, string>, cwd: string): string | null {
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
      ? env.XDG_CONFIG_HOME
      : env.HOME !== undefined && env.HOME !== ""
        ? join(env.HOME, ".config")
        : null;
  if (base === null) return null;
  const resolved = isAbsolute(base) ? resolve(base) : resolve(cwd, base);
  return resolved.length <= 1024 ? join(resolved, "opencode") : null;
}

function statNamedFile(dir: string, name: string): string {
  if (!(CONTEXT_FILES as readonly string[]).includes(name)) {
    throw new Error(`refusing to stat non-opencode context file: ${name}`);
  }
  try {
    const real = realpathSync.native(join(dir, name));
    const info = statSync(real);
    if (!info.isFile()) return `${name}:other`;
    return `${name}:f:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return `${name}:missing`;
  }
}

/**
 * Config/auth file identity for discovery cache keys: stats only files named
 * exactly `opencode.json`/`auth.json`, never values or contents.
 */
export function opencodeConfigIdentity(env: Record<string, string>, cwd: string): string {
  const dir = configDir(env, cwd);
  if (dir === null) return "none";
  const tag = dir.length <= 256 ? dir : "#";
  return `${tag}|${statNamedFile(dir, "opencode.json")}|${statNamedFile(dir, "auth.json")}`;
}

/**
 * Bounded, read-only opencode model catalog discovery over
 * `opencode models [--verbose]`. Never starts a session, writes config, or
 * performs inference. Discovered ids pass through exactly to `-m`.
 */
export async function discoverOpencodeModels(
  request: OpencodeModelDiscoveryRequest,
): Promise<OpencodeModelDiscovery> {
  if (typeof request !== "object" || request === null || !validateDiscoveryRequest(request)) {
    return failure("unavailable", MESSAGES.invalidRequest);
  }
  if (request.signal?.aborted === true) {
    return failure("unavailable", MESSAGES.cancelled);
  }
  const totalMs = boundMs(request.timeoutMs, TOTAL_MS);
  const maxStdout = boundCount(request.maxStdoutBytes, STDOUT_MAX);
  const maxStderr = boundCount(request.maxStderrBytes, STDERR_MAX);
  const maxModels = boundCount(request.maxModels, MODELS_MAX);
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, totalMs - (Date.now() - startedAt));
  const bin = resolveOpencodeBin(request.bin, request.env, request.cwd);
  if (bin === null) return failure("unavailable", MESSAGES.missing);

  const args = ["models"];
  if (request.verbose === true) args.push("--verbose");
  let stdout: string;
  let stdoutBytes = 0;
  try {
    const result = await runCommand(
      {
        cmd: bin,
        args,
        cwd: request.cwd,
        env: { ...request.env },
        timeoutMs: remaining(),
        maxStdoutBytes: maxStdout,
        maxStderrBytes: maxStderr,
      },
      {},
      request.signal,
    );
    if (result.killedBy === "timeout") return failure("unavailable", MESSAGES.timeout);
    if (result.killedBy === "cancel") return failure("unavailable", MESSAGES.cancelled);
    stdout = result.stdout;
    stdoutBytes = result.stdoutBytes;
    const combined = `${result.stdout}\n${result.stderr}`;
    if (
      /not logged|login|sign in|unauthori[sz]ed|credential|api.?key|auth/i.test(combined) &&
      parseOpencodeModels(stdout).items.length === 0
    ) {
      return failure("authRequired", MESSAGES.authRequired);
    }
    if (result.exitCode !== 0) {
      if (/unknown (?:flag|option|command)|not support|usage:/i.test(combined)) {
        return failure("unsupported", MESSAGES.unsupported);
      }
      const { items } = parseOpencodeModels(stdout);
      if (items.length > 0) {
        return {
          status: "ready",
          items: items.slice(0, maxModels),
          cliVersion: null,
          truncated: items.length > maxModels || stdoutBytes > maxStdout,
        };
      }
      return failure("unavailable", MESSAGES.unavailable);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "E_CLI_MISSING")
      return failure("unavailable", MESSAGES.missing);
    return failure("unavailable", MESSAGES.unavailable);
  }

  if (stdoutBytes > maxStdout) return failure("unavailable", MESSAGES.oversize);
  const parsed = parseOpencodeModels(stdout);
  const items = parsed.items.slice(0, maxModels);
  return {
    status: "ready",
    items,
    cliVersion: null,
    truncated: parsed.truncated || parsed.items.length > maxModels,
  };
}
