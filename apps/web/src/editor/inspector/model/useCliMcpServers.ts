import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogCli, CliMcpServers } from "./mcp-servers.js";
import { cliMcpServersClient, type McpServersClient } from "./mcp-servers.js";

export type McpServersLoading = "idle" | "load" | "refresh";

export interface UseCliMcpServersOptions {
  projectId: string | undefined;
  cli: CatalogCli;
  nodeId: string;
  client?: McpServersClient | undefined;
  loadTimeoutMs?: number | undefined;
  refreshTimeoutMs?: number | undefined;
}

export interface CliMcpServersResult {
  data: CliMcpServers | null;
  loading: McpServersLoading;
  error: string | null;
  refresh(): void;
}

interface McpServersState {
  key: string | null;
  data: CliMcpServers | null;
  loading: McpServersLoading;
  error: string | null;
}

const LOAD_TIMEOUT_MS = 8_000;
const REFRESH_TIMEOUT_MS = 20_000;

function requestKey(projectId: string, cli: CatalogCli, nodeId: string): string {
  return `${projectId}${cli}${nodeId}`;
}

function emptyState(key: string | null): McpServersState {
  return { key, data: null, loading: "idle", error: null };
}

function errorMessage(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return "The MCP server request timed out. Only Relay tools will be attached.";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The MCP server request was cancelled.";
  }
  if (error instanceof Error && /no getCliMcpServers/i.test(error.message)) {
    return error.message;
  }
  return "MCP server discovery is unavailable. Only Relay tools will be attached.";
}

/**
 * Lists the MCP servers a CLI knows for a project. Mirrors
 * `useCliModelCatalog` (manual fetch with timeout + abort; keyed by
 * projectId+cli) instead of react-query so the inspector keeps working
 * without a QueryClientProvider, like its sibling hook.
 */
export function useCliMcpServers({
  projectId,
  cli,
  nodeId,
  client = cliMcpServersClient,
  loadTimeoutMs = LOAD_TIMEOUT_MS,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
}: UseCliMcpServersOptions): CliMcpServersResult {
  const key = projectId === undefined ? null : requestKey(projectId, cli, nodeId);
  const [state, setState] = useState<McpServersState>(() => emptyState(key));
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
        data: previous.key === nextKey ? previous.data : null,
        loading: mode,
        error: null,
      }));

      const settleError = (error: unknown, timedOut: boolean) => {
        if (requestSequence !== sequence.current) return;
        const message = errorMessage(error, timedOut);
        setState((previous) =>
          previous.key === nextKey
            ? { ...previous, loading: "idle", error: message }
            : { key: nextKey, data: null, loading: "idle", error: message },
        );
      };

      let request: Promise<CliMcpServers>;
      try {
        request = client.getCliMcpServers(projectId, cli, { signal: controller.signal });
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
            reject(new Error("MCP server request deadline exceeded."));
          },
          mode === "load" ? loadTimeoutMs : refreshTimeoutMs,
        );
      });

      Promise.race([request, timeout])
        .then((data) => {
          if (requestSequence !== sequence.current) return;
          if (data.projectId !== projectId || data.cli !== cli) {
            settleError(
              new Error("The MCP server response did not match this CLI and project."),
              false,
            );
            return;
          }
          setState({ key: nextKey, data, loading: "idle", error: null });
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
    if (projectId === undefined) return;
    run("load");
  }, [projectId, run]);

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
    data: visible.data,
    loading: visible.loading,
    error: visible.error,
    refresh,
  };
}
