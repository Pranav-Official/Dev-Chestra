import { dirname, join } from "node:path";
import type { InternalMcpServer, ReaderResult } from "./types.js";
import {
  absProjectDir,
  invalidServer,
  isRecord,
  isValidName,
  parseGenericServerEntry,
  parseJsonFile,
  resolveHome,
  toInternal,
  tryReadFile,
} from "./util.js";

function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.CLAUDE_CONFIG_DIR;
  if (typeof override === "string" && override !== "") return override;
  return join(home, ".claude");
}

/** `~/.claude.json` lives next to the config dir (its parent); honours CLAUDE_CONFIG_DIR. */
function claudeJsonPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (typeof dir === "string" && dir !== "") return join(dirname(dir), ".claude.json");
  return join(home, ".claude.json");
}

/** Approval lists from a settings file; null when the file is absent. */
function readApprovalLists(path: string): { enabled: string[]; disabled: string[] } | null {
  const text = tryReadFile(path);
  if (text === null) return null;
  const parsed = parseJsonFile(text);
  if (!isRecord(parsed)) throw new Error(`invalid JSON in ${path}`);
  const pick = (key: string): string[] => {
    const value = parsed[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new Error(`invalid JSON in ${path}`);
    }
    return value as string[];
  };
  return { enabled: pick("enabledMcpjsonServers"), disabled: pick("disabledMcpjsonServers") };
}

export function discoverClaudeServers(
  projectDir: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ReaderResult {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  const servers: InternalMcpServer[] = [];
  const warnings: string[] = [];
  const scanned: string[] = [];
  const absProject = absProjectDir(projectDir);

  const jsonPath = claudeJsonPath(env, home);
  const jsonText = tryReadFile(jsonPath);
  if (jsonText !== null) {
    scanned.push(jsonPath);
    try {
      const parsed = parseJsonFile(jsonText);
      if (!isRecord(parsed)) throw new Error("invalid claude.json");
      const userServers = parsed.mcpServers;
      if (userServers !== undefined) {
        if (!isRecord(userServers)) throw new Error("invalid claude.json");
        for (const [name, entry] of Object.entries(userServers)) {
          if (!isValidName(name)) {
            warnings.push(`Skipping invalid MCP server name in ${jsonPath}.`);
            continue;
          }
          const generic = parseGenericServerEntry(entry);
          servers.push(
            generic === null
              ? invalidServer(name, "global", jsonPath)
              : toInternal(name, "global", jsonPath, generic, "ready"),
          );
        }
      }
      const projects = parsed.projects;
      if (isRecord(projects)) {
        const local = projects[absProject];
        if (isRecord(local) && local.mcpServers !== undefined) {
          if (!isRecord(local.mcpServers)) throw new Error("invalid claude.json");
          for (const [name, entry] of Object.entries(local.mcpServers)) {
            if (!isValidName(name)) {
              warnings.push(`Skipping invalid MCP server name in ${jsonPath}.`);
              continue;
            }
            const generic = parseGenericServerEntry(entry);
            servers.push(
              generic === null
                ? invalidServer(name, "project", jsonPath)
                : toInternal(name, "project", jsonPath, generic, "ready"),
            );
          }
        }
      }
    } catch {
      warnings.push(`Skipping malformed MCP config ${jsonPath}.`);
    }
  }

  const projectPath = join(absProject, ".mcp.json");
  const projectText = tryReadFile(projectPath);
  if (projectText !== null) {
    scanned.push(projectPath);
    try {
      const parsed = parseJsonFile(projectText);
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) throw new Error("invalid .mcp.json");
      const configDir = claudeConfigDir(env, home);
      const settingsPaths = [
        join(configDir, "settings.json"),
        join(absProject, ".claude", "settings.json"),
        join(absProject, ".claude", "settings.local.json"),
      ];
      const enabled = new Set<string>();
      const disabled = new Set<string>();
      let settingsFound = false;
      for (const settingsPath of settingsPaths) {
        try {
          const lists = readApprovalLists(settingsPath);
          if (lists === null) continue;
          settingsFound = true;
          for (const name of lists.enabled) enabled.add(name);
          for (const name of lists.disabled) disabled.add(name);
        } catch {
          warnings.push(`Skipping malformed MCP config ${settingsPath}.`);
        }
      }
      for (const [name, entry] of Object.entries(parsed.mcpServers)) {
        if (!isValidName(name)) {
          warnings.push(`Skipping invalid MCP server name in ${projectPath}.`);
          continue;
        }
        const generic = parseGenericServerEntry(entry);
        if (generic === null) {
          servers.push(invalidServer(name, "project", projectPath));
          continue;
        }
        const status = disabled.has(name)
          ? "disabled-in-cli"
          : enabled.has(name)
            ? "ready"
            : settingsFound
              ? "needs-trust"
              : "ready";
        if (status === "ready" && !settingsFound) {
          warnings.push(
            `Approval state unknown for project MCP server "${name}"; treating as ready.`,
          );
        }
        servers.push(toInternal(name, "project", projectPath, generic, status));
      }
    } catch {
      warnings.push(`Skipping malformed MCP config ${projectPath}.`);
    }
  }

  return { servers, scanned, warnings };
}
