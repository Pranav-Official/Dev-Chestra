import type { CatalogCli, CliListResponse, CliStatusResponse, RunStatus } from "@devchestra/api";
import { isProdCliId } from "@devchestra/schema";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { workflowApi } from "../editor/api/workflowApi.js";
import { api } from "./client.js";
import { hintInvalidations, RECONNECT_INVALIDATIONS } from "./hints.js";

export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  runs: ["runs"] as const,
  runsFor: (projectId: string) => ["runs", projectId] as const,
  execution: (runId: string, path: string) => ["execution", runId, path] as const,
  transcript: (runId: string, path: string) => ["transcript", runId, path] as const,
  groups: (projectId: string) => ["workflow-groups", projectId] as const,
  workflows: (projectId: string) => ["workflows", projectId] as const,
  workflow: (projectId: string, workflowId: string) => ["workflow", projectId, workflowId] as const,
  approvals: ["approvals"] as const,
  providers: ["providers"] as const,
  providerStatuses: ["providerStatuses"] as const,
};

export async function listAllWorkflows(projectId: string, signal: AbortSignal) {
  const items: import("@devchestra/api").WorkflowListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await workflowApi.list(
      projectId,
      { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
      { signal },
    );
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { items, nextCursor: null };
}

export function useWorkflowGroups(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groups(projectId),
    queryFn: ({ signal }) => api.getWorkflowGroups(projectId, { signal }),
    enabled: enabled && projectId !== "",
    staleTime: 5_000,
    retry: false,
  });
}

export function useProjectWorkflows(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workflows(projectId),
    queryFn: ({ signal }) => listAllWorkflows(projectId, signal),
    enabled: enabled && projectId !== "",
    staleTime: 5_000,
    retry: (failureCount, error) => {
      const name = (error as { name?: string } | null)?.name;
      if (name === "WorkflowApiUnavailableError") return false;
      return failureCount < 2;
    },
  });
}

export function useWorkflowDocument(projectId: string, workflowId: string) {
  return useQuery({
    queryKey: queryKeys.workflow(projectId, workflowId),
    queryFn: ({ signal }) => workflowApi.get(projectId, workflowId, { signal }),
    enabled: projectId !== "" && workflowId !== "",
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function useRegisterProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.registerProject({ path }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
    },
  });
}

export function useRelinkProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.relinkProject(projectId, { path }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows(projectId) });
    },
  });
}

export function useBootstrap() {
  return useQuery({
    queryKey: queryKeys.bootstrap,
    queryFn: ({ signal }) => api.bootstrap({ signal }),
    staleTime: 10_000,
  });
}

export function useAllRuns() {
  return useQuery({
    queryKey: queryKeys.runs,
    queryFn: ({ signal }) => api.listRuns({ limit: 100 }, { signal }),
    staleTime: 5_000,
  });
}

export function useProjectRuns(
  projectId: string,
  status?: RunStatus,
  workflow?: string,
  archived = false,
) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.runsFor(projectId), status ?? "all", workflow ?? "all", archived],
    queryFn: ({ pageParam, signal }) =>
      api.listRuns(
        {
          project: projectId,
          archived: archived ? "true" : "false",
          limit: 50,
          ...(status === undefined ? {} : { status }),
          ...(workflow === undefined ? {} : { workflow }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useExecutionDetail(runId: string, path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.execution(runId, path ?? ""),
    queryFn: ({ signal }) => api.getExecution(runId, path ?? "", { signal }),
    enabled: enabled && path !== null && path.length > 0,
    staleTime: 2_000,
  });
}

export function useTranscriptPages(runId: string, path: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.transcript(runId, path ?? ""),
    queryFn: ({ pageParam, signal }) =>
      api.getExecutionTranscript(
        runId,
        path ?? "",
        { limit: 200, ...(pageParam === null ? {} : { cursor: pageParam }) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: enabled && path !== null && path.length > 0,
    staleTime: 1_000,
  });
}

export function useApprovalsInbox() {
  return useInfiniteQuery({
    queryKey: queryKeys.approvals,
    queryFn: ({ pageParam, signal }) =>
      api.listApprovals(
        { limit: 50, ...(pageParam === null ? {} : { cursor: pageParam }) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 5_000,
  });
}

/** Keeps the production providers only; `fake` exists in tests and never shows here. */
function selectProdClis(data: CliListResponse): CliListResponse {
  return { clis: data.clis.filter((entry) => isProdCliId(entry.id)) };
}

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.listClis({ signal }),
    select: selectProdClis,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useProviderStatuses() {
  return useQuery({
    queryKey: queryKeys.providerStatuses,
    queryFn: ({ signal }) => api.listCliStatus({ signal }),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useSetProviderEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cli, enabled }: { cli: CatalogCli; enabled: boolean }) =>
      api.setCliEnabled(cli, { enabled }),
    onMutate: async ({ cli, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.providers });
      const previous = queryClient.getQueryData<CliListResponse>(queryKeys.providers);
      queryClient.setQueryData<CliListResponse>(queryKeys.providers, (current) =>
        current === undefined
          ? current
          : {
              clis: current.clis.map((entry) => (entry.id === cli ? { ...entry, enabled } : entry)),
            },
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.providers, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    },
  });
}

export function useProbeProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cli: CatalogCli) => api.probeCli(cli),
    onSuccess: (status) => {
      queryClient.setQueryData<CliStatusResponse>(queryKeys.providerStatuses, (current) => {
        const statuses = current?.statuses ?? [];
        const exists = statuses.some((entry) => entry.id === status.id);
        return {
          statuses: exists
            ? statuses.map((entry) => (entry.id === status.id ? status : entry))
            : [...statuses, status],
        };
      });
    },
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One global hint stream for the whole app. Hints only invalidate cached lists;
 * they are never fed into the shared run reducer.
 */
export function useGlobalStream(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          for await (const message of api.streamGlobalEvents({ signal: controller.signal })) {
            if (stopped) return;
            for (const queryKey of hintInvalidations(message)) {
              void queryClient.invalidateQueries({ queryKey });
            }
          }
        } catch (error) {
          if (controller.signal.aborted || stopped) return;
          const name = (error as { name?: string } | null)?.name;
          if (name === "ApiError" && (error as { status?: number }).status === 401) return;
        }
        for (const queryKey of RECONNECT_INVALIDATIONS) {
          void queryClient.invalidateQueries({ queryKey });
        }
        await delay(3_000, controller.signal);
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [queryClient]);
}
