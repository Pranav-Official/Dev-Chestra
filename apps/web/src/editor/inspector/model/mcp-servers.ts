import type {
  ApiRequestOptions,
  CatalogCli,
  CliMcpServers,
  DiscoveredMcpServer,
} from "@devchestra/api";
import { api } from "../../../api/client.js";

export type { CatalogCli, CliMcpServers, DiscoveredMcpServer };

export type McpServersRequestOptions = ApiRequestOptions;

export interface McpServersClient {
  getCliMcpServers(
    projectId: string,
    cli: CatalogCli,
    options?: McpServersRequestOptions,
  ): Promise<CliMcpServers>;
}

/**
 * Thin wrapper over the API client. The `getCliMcpServers` method lands on
 * the shared client in a parallel change; until then this throws a clear
 * error instead of failing obscurely. Integration is a one-line change:
 * point this at `api` directly once the method exists.
 */
export const cliMcpServersClient: McpServersClient = {
  getCliMcpServers(projectId, cli, options) {
    const candidate = api as unknown as Partial<McpServersClient>;
    if (typeof candidate.getCliMcpServers !== "function") {
      throw new Error(
        "MCP server discovery is unavailable: the API client has no getCliMcpServers method yet.",
      );
    }
    return (candidate.getCliMcpServers as McpServersClient["getCliMcpServers"])(
      projectId,
      cli,
      options,
    );
  },
};
