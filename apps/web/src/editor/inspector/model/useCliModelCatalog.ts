import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CatalogCli,
  type CliModelCatalog,
  type CliModelCatalogClient,
  cliModelCatalogClient,
} from "./catalog.js";

export type CatalogLoading = "idle" | "load" | "refresh";

export interface UseCliModelCatalogOptions {
  projectId: string | undefined;
  cli: CatalogCli;
  nodeId: string;
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

interface CatalogState {
  key: string | null;
  catalog: CliModelCatalog | null;
  loading: CatalogLoading;
  error: string | null;
}

const LOAD_TIMEOUT_MS = 8_000;
const REFRESH_TIMEOUT_MS = 20_000;

function requestKey(projectId: string, cli: CatalogCli, nodeId: string): string {
  return `${projectId}\u0000${cli}\u0000${nodeId}`;
}

function emptyState(key: string | null): CatalogState {
  return { key, catalog: null, loading: "idle", error: null };
}

function errorMessage(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return "The model catalog request timed out. Use the CLI default or a custom model ID.";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The model catalog request was cancelled.";
  }
  return "Model discovery is unavailable. Use the CLI default or a custom model ID.";
}

export function useCliModelCatalog({
  projectId,
  cli,
  nodeId,
  open,
  client = cliModelCatalogClient,
  loadTimeoutMs = LOAD_TIMEOUT_MS,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
}: UseCliModelCatalogOptions): CliModelCatalogResult {
  const key = projectId === undefined ? null : requestKey(projectId, cli, nodeId);
  const [state, setState] = useState<CatalogState>(() => emptyState(key));
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);

  const run = useCallback(
    (mode: "load" | "refresh") => {
      if (projectId === undefined) return;
      const nextKey = requestKey(projectId, cli, nodeId);
      sequence.current += 1;
      const requestSequence = sequence.current;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;

      setState((previous) => ({
        key: nextKey,
        catalog: previous.key === nextKey ? previous.catalog : null,
        loading: mode,
        error: null,
      }));

      const settleError = (error: unknown, timedOut: boolean) => {
        if (requestSequence !== sequence.current) return;
        const message = errorMessage(error, timedOut);
        setState((previous) =>
          previous.key === nextKey
            ? { ...previous, loading: "idle", error: message }
            : { key: nextKey, catalog: null, loading: "idle", error: message },
        );
      };

      let request: Promise<CliModelCatalog>;
      try {
        request =
          mode === "load"
            ? client.getCliModels(projectId, cli, { signal: controller.signal })
            : client.refreshCliModels(projectId, cli, { signal: controller.signal });
      } catch (error) {
        active.current = null;
        settleError(error, false);
        return;
      }

      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            controller.abort();
            reject(new Error("Model catalog deadline exceeded."));
          },
          mode === "load" ? loadTimeoutMs : refreshTimeoutMs,
        );
      });

      Promise.race([request, timeout])
        .then((catalog) => {
          if (requestSequence !== sequence.current) return;
          if (catalog.projectId !== projectId || catalog.cli !== cli) {
            settleError(
              new Error("The model catalog response did not match this CLI and project."),
              false,
            );
            return;
          }
          setState({ key: nextKey, catalog, loading: "idle", error: null });
        })
        .catch((error: unknown) => {
          settleError(error, timedOut);
        })
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer);
          if (active.current === controller) active.current = null;
        });
    },
    [cli, client, loadTimeoutMs, nodeId, projectId, refreshTimeoutMs],
  );

  useEffect(() => {
    if (!open || projectId === undefined) return;
    run("load");
  }, [open, projectId, run]);

  useEffect(() => {
    void key;
    return () => {
      sequence.current += 1;
      active.current?.abort();
      active.current = null;
    };
  }, [key]);

  const refresh = useCallback(() => {
    run("refresh");
  }, [run]);

  const visible = state.key === key ? state : emptyState(key);
  return {
    catalog: visible.catalog,
    loading: visible.loading,
    error: visible.error,
    refresh,
  };
}
