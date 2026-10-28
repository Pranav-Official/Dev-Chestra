import { join } from "node:path";
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

function piAgentDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override !== "") return override;
  return join(home, ".pi", "agent");
}

/** Trust map `{ "<abs path>": true }`; null when absent, throws when malformed. */
function readTrust(path: string): Record<string, unknown> | null {
  const text = tryReadFile(path);
  if (text === null) return null;
  const parsed = parseJsonFile(text);
  if (!isRecord(parsed)) throw new Error(`invalid trust in ${path}`);
  return parsed;
}

function readPiFile(
  path: string,
  scope: "global" | "project",
  statusFor: (name: string) => InternalMcpServer["status"],
): { servers: InternalMcpServer[]; warnings: string[]; scanned: string[] } {
  const text = tryReadFile(path);
  if (text === null) return { servers: [], warnings: [], scanned: [] };
  const scanned = [path];
  try {
    const parsed = parseJsonFile(text);
    if (!isRecord(parsed)) throw new Error("invalid mcp.json");
    const section = isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed.mcp)
        ? parsed.mcp
        : undefined;
    if (section === undefined) return { servers: [], warnings: [], scanned };
    if (!isRecord(section)) throw new Error("invalid mcp.json");
    const servers: InternalMcpServer[] = [];
    const warnings: string[] = [];
    for (const [name, entry] of Object.entries(section)) {
      if (!isValidName(name)) {
        warnings.push(`Skipping invalid MCP server name in ${path}.`);
        continue;
      }
      const generic = parseGenericServerEntry(entry);
      servers.push(
        generic === null
          ? invalidServer(name, scope, path)
          : toInternal(name, scope, path, generic, statusFor(name)),
      );
    }
    return { servers, warnings, scanned };
  } catch {
    return { servers: [], warnings: [`Skipping malformed MCP config ${path}.`], scanned };
  }
}

export function discoverPiServers(
  projectDir: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ReaderResult {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  const absProject = absProjectDir(projectDir);
  const agentDir = piAgentDir(env, home);
  const servers: InternalMcpServer[] = [];
  const warnings: string[] = [];
  const scanned: string[] = [];

  const global = readPiFile(join(agentDir, "mcp.json"), "global", () => "ready");
  servers.push(...global.servers);
  warnings.push(...global.warnings);
  scanned.push(...global.scanned);

  const trustPath = join(agentDir, "trust.json");
  let trusted = false;
  try {
    const trust = readTrust(trustPath);
    if (trust !== null) scanned.push(trustPath);
    trusted = trust?.[absProject] === true;
  } catch {
    warnings.push(`Skipping malformed MCP config ${trustPath}.`);
    scanned.push(trustPath);
  }

  const projectPath = join(absProject, ".pi", "mcp.json");
  if (trusted) {
    const project = readPiFile(projectPath, "project", () => "ready");
    servers.push(...project.servers);
    warnings.push(...project.warnings);
    scanned.push(...project.scanned);
  } else if (tryReadFile(projectPath) !== null) {
    scanned.push(projectPath);
    try {
      const parsed = parseJsonFile(tryReadFile(projectPath) ?? "");
      const section = isRecord(parsed)
        ? isRecord(parsed.mcpServers)
          ? parsed.mcpServers
          : isRecord(parsed.mcp)
            ? parsed.mcp
            : null
        : null;
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
  return { servers, scanned, warnings };
}
