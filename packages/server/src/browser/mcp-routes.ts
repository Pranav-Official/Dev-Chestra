import { homedir } from "node:os";
import { createMcpResolver, scannedMcpPaths } from "@devchestra/adapters";
import {
  type CatalogCli,
  type CliMcpServers,
  catalogCliSchema,
  cliMcpServersSchema,
} from "@devchestra/api";
import type { Context, Hono } from "hono";
import { DevChestraError, errorBody } from "../errors.js";
import type { BrowserMcpServersPort, BrowserQueryPort } from "./ports.js";

export interface McpRouteDeps {
  store: BrowserQueryPort;
  mcpServers?: BrowserMcpServersPort;
  validate: (name: string, value: unknown) => void;
}

export interface McpServersPortOptions {
  /** Resolve a project id to its absolute directory. Return null when unknown. */
  getProjectDir: (projectId: string) => Promise<string | null> | string | null;
  /** Test seam: fake home dir. Defaults to `env.HOME` or the OS home. */
  home?: string;
  /** Test seam: environment overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function effectiveHome(options: McpServersPortOptions): string {
  if (options.home !== undefined && options.home !== "") return options.home;
  const env = options.env ?? process.env;
  const fromEnv = env.HOME;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  try {
    return homedir();
  } catch {
    return "";
  }
}

function displayPath(path: string, home: string): string {
  if (home !== "" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * Read-only MCP discovery port backed by the adapters resolver. Returned
 * servers carry names and short summaries only, never secret values.
 */
export function createMcpServersPort(options: McpServersPortOptions): BrowserMcpServersPort {
  const env = options.env ?? process.env;
  const home = effectiveHome(options);
  const resolverOpts = {
    ...(options.home === undefined ? {} : { home: options.home }),
    env,
  };
  const resolver = createMcpResolver(resolverOpts);
  return {
    async list(projectId, cli): Promise<CliMcpServers> {
      const projectDir = await options.getProjectDir(projectId);
      if (projectDir === null) throw new DevChestraError("E_NOT_FOUND", "Project not found.");
      const { servers, warnings } = await resolver.list(cli, projectDir);
      return {
        cli,
        projectId,
        servers: servers.slice(0, 500).map((server) => ({
          ...server,
          source: displayPath(server.source, home).slice(0, 512),
        })),
        scanned: scannedMcpPaths(cli, projectDir, resolverOpts)
          .slice(0, 50)
          .map((path) => displayPath(path, home).slice(0, 512)),
        warnings: warnings.slice(0, 50).map((warning) => warning.slice(0, 256)),
      };
    },
  };
}

function emptyBody(projectId: string, cli: CatalogCli, warnings: string[]): CliMcpServers {
  return { cli, projectId, servers: [], scanned: [], warnings };
}

function assertOutbound(value: unknown, projectId: string, cli: CatalogCli): CliMcpServers {
  const parsed = cliMcpServersSchema.safeParse(value);
  if (!parsed.success) {
    throw new DevChestraError("E_INTERNAL", "MCP servers response was invalid.");
  }
  const body = parsed.data as CliMcpServers;
  if (body.projectId !== projectId || body.cli !== cli) {
    throw new DevChestraError("E_INTERNAL", "MCP servers response did not match the request.");
  }
  return body;
}

function rejectsQuery(c: Context): boolean {
  return new URL(c.req.url).search !== "";
}

export function mountMcpRoutes(app: Hono, deps: McpRouteDeps): void {
  app.get("/api/projects/:pid/clis/:cli/mcp-servers", async (c) => {
    if (rejectsQuery(c)) {
      return c.json(errorBody("E_VALIDATION", "MCP server routes do not accept query data."), 400);
    }
    const projectId = c.req.param("pid") ?? "";
    const project = await deps.store.getProject(projectId);
    if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    if (project.missing) {
      return c.json(
        errorBody(
          "E_CONFLICT",
          "Project path is missing; relink the project before loading MCP servers.",
        ),
        409,
      );
    }
    const cli = catalogCliSchema.safeParse(c.req.param("cli"));
    if (!cli.success) {
      return c.json(errorBody("E_VALIDATION", "CLI is not supported for MCP discovery."), 400);
    }
    const port = deps.mcpServers;
    if (port === undefined) {
      const body = emptyBody(projectId, cli.data, ["MCP discovery is not available for this CLI."]);
      deps.validate("CliMcpServers", body);
      return c.json(body);
    }
    let result: CliMcpServers;
    try {
      result = await port.list(projectId, cli.data);
    } catch {
      const body = emptyBody(projectId, cli.data, ["MCP discovery is temporarily unavailable."]);
      deps.validate("CliMcpServers", body);
      return c.json(body);
    }
    const body = assertOutbound(result, projectId, cli.data);
    deps.validate("CliMcpServers", body);
    return c.json(body);
  });
}
