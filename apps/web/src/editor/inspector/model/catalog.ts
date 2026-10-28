import type { ApiRequestOptions, CatalogCli, CliModelCatalog } from "@devchestra/api";
import { api } from "../../../api/client.js";

export type { CatalogCli, CliModelCatalog, CliModelItem } from "@devchestra/api";

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
