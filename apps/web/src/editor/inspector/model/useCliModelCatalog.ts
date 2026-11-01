import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  type CatalogCli,
  type CliModelCatalog,
  type CliModelCatalogClient,
  cliModelCatalogClient,
} from "./catalog.js";
import {
  type CatalogLoading,
  catalogKey,
  ensureCatalog,
  getEntry,
  IDLE_ENTRY,
  startRequest,
  subscribe,
} from "./catalogCache.js";

export type { CatalogLoading } from "./catalogCache.js";

export interface UseCliModelCatalogOptions {
  projectId: string | undefined;
  cli: CatalogCli;
  // Ignored. Kept so existing callers compile; catalogs are shared per project and CLI.
  nodeId?: string;
  open: boolean;
  client?: CliModelCatalogClient;
  loadTimeoutMs?: number;
  refreshTimeoutMs?: number;
}

export interface CliModelCatalogResult {
  catalog: CliModelCatalog | null;
  loading: CatalogLoading;
  error: string | null;
  refresh(): void;
}

const LOAD_TIMEOUT_MS = 8_000;
const REFRESH_TIMEOUT_MS = 20_000;

const noop = () => undefined;

export function useCliModelCatalog({
  projectId,
  cli,
  open,
  client = cliModelCatalogClient,
  loadTimeoutMs = LOAD_TIMEOUT_MS,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
}: UseCliModelCatalogOptions): CliModelCatalogResult {
  const key = projectId === undefined ? null : catalogKey(projectId, cli);
  const subscribeToKey = useCallback(
    (listener: () => void) => (key === null ? noop : subscribe(key, listener)),
    [key],
  );
  const readEntry = useCallback(() => (key === null ? IDLE_ENTRY : getEntry(key)), [key]);
  const entry = useSyncExternalStore(subscribeToKey, readEntry);

  useEffect(() => {
    if (!open || projectId === undefined) return;
    ensureCatalog(catalogKey(projectId, cli), {
      projectId,
      cli,
      client,
      loadTimeoutMs,
      refreshTimeoutMs,
    });
  }, [open, projectId, cli, client, loadTimeoutMs, refreshTimeoutMs]);

  const refresh = useCallback(() => {
    if (projectId === undefined) return;
    startRequest(catalogKey(projectId, cli), "refresh", {
      projectId,
      cli,
      client,
      loadTimeoutMs,
      refreshTimeoutMs,
    });
  }, [projectId, cli, client, loadTimeoutMs, refreshTimeoutMs]);

  return {
    catalog: entry.catalog,
    loading: entry.loading,
    error: entry.error,
    refresh,
  };
}
