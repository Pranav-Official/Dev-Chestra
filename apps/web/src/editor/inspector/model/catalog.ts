import type { ApiRequestOptions, CatalogCli, CliModelCatalog } from "@relay/api";
import { api } from "../../../api/client.js";

export type { CatalogCli, CliModelCatalog, CliModelItem } from "@relay/api";

export type CliModelRequestOptions = ApiRequestOptions;

export interface CliModelCatalogClient {
  getCliModels(
    projectId: string,
    cli: CatalogCli,
    options?: CliModelRequestOptions,
  ): Promise<CliModelCatalog>;
  refreshCliModels(
    projectId: string,
    cli: CatalogCli,
    options?: CliModelRequestOptions,
  ): Promise<CliModelCatalog>;
}

export const cliModelCatalogClient: CliModelCatalogClient = api;
