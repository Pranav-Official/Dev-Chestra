import type { PollIssue, PollTriggerStatus } from "@devchestra/api";
import { isApiError } from "@devchestra/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, classifyError } from "./client.js";

/** Query keys for polling triggers. */
export const pollKeys = {
  trigger: (projectId: string, workflowId: string) => ["poll", projectId, workflowId] as const,
};

export function invalidatePollTrigger(
  queryClient: QueryClient,
  projectId: string,
  workflowId: string,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: pollKeys.trigger(projectId, workflowId) });
}

export interface PollFailure {
  message: string;
  issues: PollIssue[];
}

function issuesFrom(details: unknown): PollIssue[] {
  if (typeof details !== "object" || details === null) return [];
  const list = (details as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { code, message } = entry as { code?: unknown; message?: unknown };
    return typeof code === "string" && typeof message === "string" ? [{ code, message }] : [];
  });
}

/** The server message, plus the saved-file issues an E_WORKFLOW_INVALID response carries. */
export function describePollFailure(error: unknown): PollFailure {
  return {
    message: classifyError(error).message,
    issues: isApiError(error) ? issuesFrom(error.details) : [],
  };
}

export function usePollTrigger(projectId: string, workflowId: string) {
  return useQuery({
    queryKey: pollKeys.trigger(projectId, workflowId),
    queryFn: ({ signal }) => api.getPollTrigger(projectId, workflowId, { signal }),
    enabled: projectId !== "" && workflowId !== "",
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Every trigger mutation writes its status straight into the cache, then
 * invalidates the query on settle, so a failed refresh (which records
 * refreshError on the server) shows up too. A probe-now run never changes the
 * trigger state, so it writes nothing.
 */
export function useArmPollTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (intervalSeconds: number) =>
      api.armPollTrigger(projectId, workflowId, { intervalSeconds }),
    onSuccess: (status: PollTriggerStatus) => {
      queryClient.setQueryData(pollKeys.trigger(projectId, workflowId), status);
    },
    onSettled: () => {
      void invalidatePollTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useDisarmPollTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.disarmPollTrigger(projectId, workflowId),
    onSuccess: (status: PollTriggerStatus) => {
      queryClient.setQueryData(pollKeys.trigger(projectId, workflowId), status);
    },
    onSettled: () => {
      void invalidatePollTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useRefreshPollTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshPollTrigger(projectId, workflowId),
    onSuccess: (status: PollTriggerStatus) => {
      queryClient.setQueryData(pollKeys.trigger(projectId, workflowId), status);
    },
    onSettled: () => {
      void invalidatePollTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useProbePollTrigger(projectId: string, workflowId: string) {
  return useMutation({
    mutationFn: () => api.probePollTrigger(projectId, workflowId),
  });
}
