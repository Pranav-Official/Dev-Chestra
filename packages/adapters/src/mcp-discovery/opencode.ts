import { join } from "node:path";
import type { InternalMcpServer, ReaderResult } from "./types.js";
import {
  absProjectDir,
  invalidServer,
  isRecord,
  isValidName,
  parseJsonFile,
  resolveHome,
  summarizeStdio,
  summarizeUrl,
  tryReadFile,
} from "./util.js";

function opencodeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.XDG_CONFIG_HOME;
  if (typeof override === "string" && override !== "") return join(override, "opencode");
  return join(home, ".config", "opencode");
}

interface OpenCodeEntry {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    out[key] = entry;
  }
  return out;
}

/**
 * OpenCode server entry: `type: "local"` (command array + environment) or
 * `type: "remote"` (url + headers). Missing `type` is inferred from keys.
 * Returns null when unusable, "disabled" when `enabled: false`.
 */
function parseOpenCodeEntry(entry: unknown): OpenCodeEntry | "disabled" | null {
  if (!isRecord(entry)) return null;
  if (entry.enabled === false) return "disabled";
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  if (type === "local" || entry.command !== undefined) {
    let command: string;
    let args: string[];
    if (typeof entry.command === "string") {
      if (entry.command === "") return null;
      command = entry.command;
      args = [];
    } else if (Array.isArray(entry.command) && entry.command.length > 0) {
      if (!entry.command.every((part) => typeof part === "string")) return null;
      const [first, ...rest] = entry.command as string[];
      if (first === undefined || first === "") return null;
      command = first;
      args = rest;
    } else {
      return null;
    }
    const env = entry.environment === undefined ? {} : stringMap(entry.environment);
    if (env === null) return null;
    return { transport: "stdio", command, args, env };
  }
  if (type === "remote" || typeof entry.url === "string") {
    if (typeof entry.url !== "string" || entry.url === "") return null;
    const headers = entry.headers === undefined ? {} : stringMap(entry.headers);
    if (headers === null) return null;
    return { transport: "http", url: entry.url, headers };
  }
  return null;
}

/** Flat `mcp` form merged with the v2 `mcp.servers` nested form (nested wins). */
function collectEntries(
  parsed: unknown,
  path: string,
  warnings: string[],
): Array<[string, unknown]> {
  if (!isRecord(parsed) || !isRecord(parsed.mcp)) return [];
  const flat = parsed.mcp;
  const nested = isRecord(flat.servers) ? flat.servers : {};
  const names = new Set([...Object.keys(flat), ...Object.keys(nested)]);
  names.delete("servers");
  const out: Array<[string, unknown]> = [];
  for (const name of names) {
    const nestedEntry = nested[name];
    const flatEntry = flat[name];
    if (nestedEntry !== undefined && flatEntry !== undefined && nestedEntry !== flatEntry) {
      warnings.push(`Duplicate MCP server "${name}" in ${path}; using mcp.servers.`);
    }
    out.push([name, nestedEntry !== undefined ? nestedEntry : flatEntry]);
  }
  return out;
}

function readOpenCodeFile(
  path: string,
  scope: "global" | "project",
): { servers: InternalMcpServer[]; warnings: string[]; scanned: string[] } {
  const text = tryReadFile(path);
  if (text === null) return { servers: [], warnings: [], scanned: [] };
  const scanned = [path];
  try {
    const parsed = parseJsonFile(text);
    const servers: InternalMcpServer[] = [];
    const warnings: string[] = [];
    for (const [name, entry] of collectEntries(parsed, path, warnings)) {
      if (!isValidName(name)) {
        warnings.push(`Skipping invalid MCP server name in ${path}.`);
        continue;
      }
      const config = parseOpenCodeEntry(entry);
      if (config === null) {
        servers.push(invalidServer(name, scope, path));
        continue;
      }
      if (config === "disabled") {
        const shape =
          isRecord(entry) && Array.isArray(entry.command)
            ? {
                transport: "stdio" as const,
                summary: summarizeStdio(
                  (entry.command as string[])[0] ?? "",
                  (entry.command as string[]).slice(1),
                ),
                command: (entry.command as string[])[0],
                args: (entry.command as string[]).slice(1),
              }
            : {
                transport: "http" as const,
                summary: summarizeUrl(
                  isRecord(entry) && typeof entry.url === "string" ? entry.url : "",
                ),
              };
        servers.push({
          id: `${scope}:${name}`,
          name,
          scope,
          transport: shape.transport,
          summary: shape.summary,
          source: path,
          status: "disabled-in-cli",
          hasSecrets:
            (isRecord(entry) &&
              ((isRecord(entry.environment) && Object.keys(entry.environment).length > 0) ||
                (isRecord(entry.headers) && Object.keys(entry.headers).length > 0))) ||
            false,
          ...(shape.command === undefined ? {} : { command: shape.command, args: shape.args }),
        });
        continue;
      }
      const hasSecrets =
        (config.env !== undefined && Object.keys(config.env).length > 0) ||
        (config.headers !== undefined && Object.keys(config.headers).length > 0);
      servers.push({
        id: `${scope}:${name}`,
        name,
        scope,
        transport: config.transport,
        summary:
          config.transport === "stdio"
            ? summarizeStdio(config.command ?? "", config.args ?? [])
            : summarizeUrl(config.url ?? ""),
        source: path,
        status: config.enabled === false ? "disabled-in-cli" : "ready",
        hasSecrets,
        ...(config.command === undefined ? {} : { command: config.command, args: config.args }),
        ...(config.env === undefined ? {} : { env: config.env }),
        ...(config.url === undefined ? {} : { url: config.url }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      });
    }
    return { servers, warnings, scanned };
  } catch {
    return { servers: [], warnings: [`Skipping malformed MCP config ${path}.`], scanned };
  }
}

export function discoverOpenCodeServers(
  projectDir: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ReaderResult {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  const absProject = absProjectDir(projectDir);
  const servers: InternalMcpServer[] = [];
  const warnings: string[] = [];
  const scanned: string[] = [];

  for (const [path, scope] of [
    [join(opencodeConfigDir(env, home), "opencode.json"), "global"],
    [join(absProject, "opencode.json"), "project"],
  ] as const) {
    const result = readOpenCodeFile(path, scope);
    servers.push(...result.servers);
    warnings.push(...result.warnings);
    scanned.push(...result.scanned);
  }
  return { servers, scanned, warnings };
}
