import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { InternalMcpServer, ReaderResult } from "./types.js";
import {
  absProjectDir,
  cleanText,
  invalidServer,
  isRecord,
  isValidName,
  parseToml,
  resolveHome,
  summarizeStdio,
  summarizeUrl,
  tryReadFile,
} from "./util.js";

/** Connector display names that are CLI plumbing, not user servers. */
export const CODEX_INTERNAL_CONNECTOR_NAMES: readonly string[] = [
  "Sites",
  "Pets",
  "Plugin Management",
  "Safety Settings",
  "Codex Document Control",
  "Hotline",
  "Search Service",
];

function codexHome(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.CODEX_HOME;
  if (typeof override === "string" && override !== "") return override;
  return join(home, ".codex");
}

interface CodexServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envNames?: string[];
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value as string[];
}

function parseCodexEntry(entry: unknown): CodexServerConfig | null {
  if (!isRecord(entry)) return null;
  const config: CodexServerConfig = {};
  if (entry.command !== undefined) {
    if (typeof entry.command !== "string" || entry.command === "") return null;
    config.command = entry.command;
  }
  if (entry.args !== undefined) {
    const args = stringList(entry.args);
    if (args === null) return null;
    config.args = args;
  }
  if (entry.env !== undefined) {
    if (!isRecord(entry.env)) return null;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value !== "string") return null;
      env[key] = value;
    }
    config.env = env;
  }
  if (entry.env_vars !== undefined) {
    const names = stringList(entry.env_vars);
    if (names === null) return null;
    config.envNames = names;
  }
  if (entry.url !== undefined) {
    if (typeof entry.url !== "string" || entry.url === "") return null;
    config.url = entry.url;
  }
  for (const key of ["http_headers", "headers"] as const) {
    if (entry[key] !== undefined) {
      if (!isRecord(entry[key])) return null;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry[key] as Record<string, unknown>)) {
        if (typeof value !== "string") return null;
        headers[name] = value;
      }
      config.headers = headers;
    }
  }
  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== "string" || entry.cwd === "") return null;
    config.cwd = entry.cwd;
  }
  if (entry.enabled !== undefined) {
    if (typeof entry.enabled !== "boolean") return null;
    config.enabled = entry.enabled;
  }
  if (config.command === undefined && config.url === undefined) return null;
  return config;
}

function toInternalCodex(
  name: string,
  scope: "global" | "project",
  source: string,
  config: CodexServerConfig,
  status: InternalMcpServer["status"],
): InternalMcpServer {
  const hasSecrets =
    (config.env !== undefined && Object.keys(config.env).length > 0) ||
    (config.envNames !== undefined && config.envNames.length > 0) ||
    (config.headers !== undefined && Object.keys(config.headers).length > 0);
  if (config.command !== undefined) {
    return {
      id: `${scope}:${name}`,
      name,
      scope,
      transport: "stdio",
      summary: summarizeStdio(config.command, config.args ?? []),
      source,
      status,
      hasSecrets,
      command: config.command,
      args: config.args ?? [],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      env: config.env ?? {},
    };
  }
  return {
    id: `${scope}:${name}`,
    name,
    scope,
    transport: "http",
    summary: summarizeUrl(config.url ?? ""),
    source,
    status,
    hasSecrets,
    ...(config.url === undefined ? {} : { url: config.url }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  };
}

function readTomlServers(
  path: string,
  scope: "global" | "project",
  statusFor: (name: string) => InternalMcpServer["status"],
): { servers: InternalMcpServer[]; warnings: string[]; scanned: string[] } {
  const text = tryReadFile(path);
  if (text === null) return { servers: [], warnings: [], scanned: [] };
  const scanned = [path];
  try {
    const parsed = parseToml(text);
    const section = parsed.mcp_servers;
    if (section === undefined) return { servers: [], warnings: [], scanned };
    if (!isRecord(section)) throw new Error("invalid mcp_servers");
    const servers: InternalMcpServer[] = [];
    const warnings: string[] = [];
    for (const [name, entry] of Object.entries(section)) {
      if (!isValidName(name)) {
        warnings.push(`Skipping invalid MCP server name in ${path}.`);
        continue;
      }
      const config = parseCodexEntry(entry);
      if (config === null) {
        servers.push(invalidServer(name, scope, path));
        continue;
      }
      const status = config.enabled === false ? "disabled-in-cli" : statusFor(name);
      servers.push(toInternalCodex(name, scope, path, config, status));
    }
    return { servers, warnings, scanned };
  } catch {
    return { servers: [], warnings: [`Skipping malformed MCP config ${path}.`], scanned };
  }
}

function projectTrustLevel(userConfigPath: string, absProject: string): string | null {
  const text = tryReadFile(userConfigPath);
  if (text === null) return null;
  try {
    const parsed = parseToml(text);
    const projects = parsed.projects;
    if (!isRecord(projects)) return null;
    const entry = projects[absProject];
    if (!isRecord(entry)) return null;
    return typeof entry.trust_level === "string" ? entry.trust_level : null;
  } catch {
    return null;
  }
}

interface ConnectorGroup {
  connectorId: string;
  connectorName: string;
  toolCount: number;
  source: string;
}

function readConnectorCache(cacheDir: string): {
  groups: ConnectorGroup[];
  warnings: string[];
  scanned: string[];
} {
  const groups = new Map<string, ConnectorGroup>();
  const warnings: string[] = [];
  const scanned: string[] = [];
  let files: string[];
  try {
    files = readdirSync(cacheDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(cacheDir, name))
      .sort();
  } catch {
    return { groups: [], warnings, scanned };
  }
  for (const file of files) {
    const text = tryReadFile(file);
    if (text === null) continue;
    scanned.push(file);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
        throw new Error("invalid connector cache");
      }
      for (const tool of parsed.tools) {
        if (!isRecord(tool)) continue;
        const connectorId = tool.connector_id;
        const connectorName = tool.connector_name;
        if (typeof connectorId !== "string" || typeof connectorName !== "string") continue;
        if ((CODEX_INTERNAL_CONNECTOR_NAMES as readonly string[]).includes(connectorName)) continue;
        const existing = groups.get(connectorId);
        if (existing === undefined) {
          groups.set(connectorId, {
            connectorId,
            connectorName,
            toolCount: 1,
            source: file,
          });
        } else {
          existing.toolCount += 1;
        }
      }
    } catch {
      warnings.push(`Skipping malformed MCP config ${file}.`);
    }
  }
  return { groups: [...groups.values()], warnings, scanned };
}

export function discoverCodexServers(
  projectDir: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ReaderResult {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  const servers: InternalMcpServer[] = [];
  const warnings: string[] = [];
  const scanned: string[] = [];
  const absProject = absProjectDir(projectDir);
  const homeDir = codexHome(env, home);
  const userConfig = join(homeDir, "config.toml");

  const user = readTomlServers(userConfig, "global", () => "ready");
  servers.push(...user.servers);
  warnings.push(...user.warnings);
  scanned.push(...user.scanned);

  const projectPath = join(absProject, ".codex", "config.toml");
  const trusted = projectTrustLevel(userConfig, absProject) === "trusted";
  if (trusted) {
    const project = readTomlServers(projectPath, "project", () => "ready");
    servers.push(...project.servers);
    warnings.push(...project.warnings);
    scanned.push(...project.scanned);
  } else if (tryReadFile(projectPath) !== null) {
    scanned.push(projectPath);
    try {
      const parsed = parseToml(tryReadFile(projectPath) ?? "");
      const section = parsed.mcp_servers;
      if (isRecord(section)) {
        for (const name of Object.keys(section)) {
          if (!isValidName(name)) continue;
          servers.push({
            id: `project:${name}`,
            name,
            scope: "project",
            transport: "stdio",
            summary: "untrusted project config",
            source: projectPath,
            status: "needs-trust",
            hasSecrets: false,
          });
        }
      }
    } catch {
      warnings.push(`Skipping malformed MCP config ${projectPath}.`);
    }
  }

  const cache = readConnectorCache(join(homeDir, "cache", "codex_apps_tools"));
  warnings.push(...cache.warnings);
  scanned.push(...cache.scanned);
  const usedNames = new Set(servers.map((server) => `connector:${server.name}`));
  for (const group of cache.groups) {
    let name = group.connectorName;
    if (!isValidName(name) || usedNames.has(`connector:${name}`)) {
      const suffix = group.connectorId.replace(/^connector_/, "").slice(0, 6);
      name = cleanText(`${group.connectorName} (${suffix})`, 128);
      if (!isValidName(name)) continue;
    }
    usedNames.add(`connector:${name}`);
    servers.push({
      id: `connector:${name}`,
      name,
      scope: "connector",
      transport: "http",
      summary: `${group.toolCount} tools`,
      source: group.source,
      status: "ready",
      hasSecrets: false,
      toolCount: group.toolCount,
      connectorId: group.connectorId,
    });
  }

  return { servers, scanned, warnings };
}
