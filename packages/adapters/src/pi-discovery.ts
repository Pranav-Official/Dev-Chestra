import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { runCommand } from "./command.js";
import {
  boundCount,
  boundMs,
  hasControl,
  printable,
  validateDiscoveryRequest,
} from "./discovery-util.js";
import type { PiModelDiscovery, PiModelDiscoveryRequest, PiModelItem } from "./types.js";

const TOTAL_MS = 15_000;
const VERSION_MS = 5_000;
const STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 64 * 1024;
const MODELS_MAX = 1000;
const ID_MAX = 256;
const LABEL_MAX = 256;
const PROVIDER_MAX = 128;

const MESSAGES = {
  invalidRequest: "Invalid model discovery request.",
  missing: "Pi CLI was not found.",
  unavailable: "Pi model discovery is unavailable.",
  authRequired: "Pi requires authentication to list models.",
} as const;

function failure(status: PiModelDiscovery["status"], message: string): PiModelDiscovery {
  return { status, items: [], cliVersion: null, truncated: false, message };
}

function capped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Parse the `pi --list-models [search]` table. Columns are separated by runs
 * of 2+ spaces; values never contain internal spaces. Returns null rows for
 * the header and malformed lines.
 */
export function parsePiModelTable(stdout: string): { items: PiModelItem[]; truncated: boolean } {
  const items: PiModelItem[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 2) {
      truncated = true;
      continue;
    }
    const [providerRaw, modelRaw] = cols as [string, string, ...string[]];
    if (/^provider$/i.test(providerRaw) && /^model$/i.test(modelRaw)) continue;
    const provider = capped(printable(providerRaw), PROVIDER_MAX);
    const model = capped(printable(modelRaw), ID_MAX);
    if (provider === "" || model === "" || hasControl(providerRaw) || hasControl(modelRaw)) {
      truncated = true;
      continue;
    }
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Persist the provider-qualified id: the bare model column is ambiguous
    // across providers (e.g. kimi-k3 exists under several), and the picker
    // saves item.id verbatim. A model that already carries its provider
    // prefix is kept as-is instead of doubled.
    const id =
      model === provider || model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
    const label = capped(model, LABEL_MAX);
    items.push({ id: capped(id, ID_MAX), label, provider, source: "pi-list-models" });
  }
  return { items, truncated };
}

/** Agent-dir file identity for discovery cache keys: never values, only stats. */
export function piConfigIdentity(env: Record<string, string>, cwd: string): string {
  const dir =
    env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR !== ""
      ? isAbsolute(env.PI_CODING_AGENT_DIR)
        ? resolve(env.PI_CODING_AGENT_DIR)
        : resolve(cwd, env.PI_CODING_AGENT_DIR)
      : env.HOME !== undefined && env.HOME !== ""
        ? join(isAbsolute(env.HOME) ? resolve(env.HOME) : resolve(cwd, env.HOME), ".pi/agent")
        : null;
  if (dir === null) return "none";
  const file = (name: string): string => {
    try {
      const real = realpathSync.native(join(dir, name));
      const info = statSync(real);
      if (!info.isFile()) return `${name}:other`;
      return `${name}:f:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return `${name}:missing`;
    }
  };
  return `${dir.length <= 256 ? dir : "#"}|${file("mcp.json")}|${file("models.json")}|${file("auth.json")}`;
}

/**
 * Bounded, read-only Pi model catalog discovery over `pi --list-models`.
 * Never starts a session, writes config, or performs inference.
 */
export async function discoverPiModels(
  request: PiModelDiscoveryRequest,
): Promise<PiModelDiscovery> {
  if (typeof request !== "object" || request === null || !validateDiscoveryRequest(request)) {
    return failure("unavailable", MESSAGES.invalidRequest);
  }
  if (request.signal?.aborted === true) {
    return failure("unavailable", MESSAGES.invalidRequest);
  }
  const totalMs = boundMs(request.timeoutMs, TOTAL_MS);
  const maxStdout = boundCount(request.maxStdoutBytes, STDOUT_MAX);
  const maxStderr = boundCount(request.maxStderrBytes, STDERR_MAX);
  const maxModels = boundCount(request.maxModels, MODELS_MAX);
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, totalMs - (Date.now() - startedAt));
  const bin = request.bin ?? "pi";

  let cliVersion: string | null = null;
  try {
    const version = await runCommand(
      {
        cmd: bin,
        args: ["--version"],
        cwd: request.cwd,
        env: { ...request.env },
        timeoutMs: Math.min(VERSION_MS, remaining()),
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      },
      {},
      request.signal,
    );
    const text = `${version.stdout}\n${version.stderr}`;
    const match = /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(text.slice(0, 1024));
    if (match?.[1] !== undefined) cliVersion = match[1].slice(0, 64);
  } catch {
    cliVersion = null;
  }

  const args = ["--list-models"];
  if (request.search !== undefined) args.push(request.search);
  let stdout: string;
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
    if (result.killedBy === "timeout")
      return failure("unavailable", "Pi model discovery timed out.");
    if (result.killedBy === "cancel")
      return failure("unavailable", "Pi model discovery was cancelled.");
    stdout = result.stdout;
    const combined = `${result.stdout}\n${result.stderr}`;
    if (
      /no models available|not logged|login|sign in|api.?key|unauthori[sz]ed|credential/i.test(
        combined,
      )
    ) {
      const { items } = parsePiModelTable(stdout);
      if (items.length === 0)
        return { ...failure("authRequired", MESSAGES.authRequired), cliVersion };
    }
    if (result.exitCode !== 0) {
      if (result.exitCode === 127 && /relay-wrapper|ENOENT/i.test(result.stderr)) {
        return { ...failure("unavailable", MESSAGES.missing), cliVersion };
      }
      const { items } = parsePiModelTable(stdout);
      if (items.length > 0) {
        return {
          status: "ready",
          items: items.slice(0, maxModels),
          cliVersion,
          truncated: items.length > maxModels,
        };
      }
      return { ...failure("unavailable", MESSAGES.unavailable), cliVersion };
    }
  } catch (error) {
    if (request.signal?.aborted) {
      return { ...failure("unavailable", "Pi model discovery was cancelled."), cliVersion };
    }
    const code = (error as { code?: unknown } | null)?.code;
    const cause = (error as { cause?: unknown } | null)?.cause as { code?: unknown } | undefined;
    if (code === "E_CANCELLED") {
      return { ...failure("unavailable", "Pi model discovery was cancelled."), cliVersion };
    }
    if (code === "E_CLI_MISSING" || code === "ENOENT" || cause?.code === "ENOENT") {
      return { ...failure("unavailable", MESSAGES.missing), cliVersion };
    }
    return { ...failure("unavailable", MESSAGES.unavailable), cliVersion };
  }

  const parsed = parsePiModelTable(stdout);
  const items = parsed.items.slice(0, maxModels);
  return {
    status: "ready",
    items,
    cliVersion,
    truncated: parsed.truncated || parsed.items.length > maxModels,
  };
}
