import type {
  ExecutionSettings,
  ExecutionSettingsResponse,
  WebhookIssue,
  WebhookSettings,
  WebhookTriggerStatus,
} from "@devchestra/api";
import { isApiError } from "@devchestra/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, classifyError } from "./client.js";

/** Query keys for webhook triggers and the global settings that govern their queue. */
export const webhookKeys = {
  trigger: (projectId: string, workflowId: string) => ["webhook", projectId, workflowId] as const,
  executionSettings: ["settings", "execution"] as const,
  webhookSettings: ["settings", "webhooks"] as const,
};

export function invalidateWebhookTrigger(
  queryClient: QueryClient,
  projectId: string,
  workflowId: string,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: webhookKeys.trigger(projectId, workflowId) });
}

export interface WebhookFailure {
  message: string;
  issues: WebhookIssue[];
}

function issuesFrom(details: unknown): WebhookIssue[] {
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
export function describeWebhookFailure(error: unknown): WebhookFailure {
  return {
    message: classifyError(error).message,
    issues: isApiError(error) ? issuesFrom(error.details) : [],
  };
}

export function useWebhookTrigger(projectId: string, workflowId: string) {
  return useQuery({
    queryKey: webhookKeys.trigger(projectId, workflowId),
    queryFn: ({ signal }) => api.getWebhookTrigger(projectId, workflowId, { signal }),
    enabled: projectId !== "" && workflowId !== "",
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Every trigger mutation writes its status straight into the cache, then
 * invalidates the query on settle, so a failed refresh (which records
 * refreshError on the server) shows up too.
 */
export function useArmWebhookTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.armWebhookTrigger(projectId, workflowId),
    onSuccess: (response) => {
      queryClient.setQueryData(webhookKeys.trigger(projectId, workflowId), response.status);
    },
    onSettled: () => {
      void invalidateWebhookTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useDisarmWebhookTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.disarmWebhookTrigger(projectId, workflowId),
    onSuccess: (status: WebhookTriggerStatus) => {
      queryClient.setQueryData(webhookKeys.trigger(projectId, workflowId), status);
    },
    onSettled: () => {
      void invalidateWebhookTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useRotateWebhookTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.rotateWebhookTrigger(projectId, workflowId),
    onSuccess: (response) => {
      queryClient.setQueryData(webhookKeys.trigger(projectId, workflowId), response.status);
    },
    onSettled: () => {
      void invalidateWebhookTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useRefreshWebhookTrigger(projectId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshWebhookTrigger(projectId, workflowId),
    onSuccess: (status: WebhookTriggerStatus) => {
      queryClient.setQueryData(webhookKeys.trigger(projectId, workflowId), status);
    },
    onSettled: () => {
      void invalidateWebhookTrigger(queryClient, projectId, workflowId);
    },
  });
}

export function useExecutionSettings() {
  return useQuery({
    queryKey: webhookKeys.executionSettings,
    queryFn: ({ signal }) => api.getExecutionSettings({ signal }),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSaveExecutionSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: ExecutionSettings) => api.saveExecutionSettings(settings),
    onSuccess: (response: ExecutionSettingsResponse) => {
      queryClient.setQueryData(webhookKeys.executionSettings, response);
    },
  });
}

export function useWebhookSettings() {
  return useQuery({
    queryKey: webhookKeys.webhookSettings,
    queryFn: ({ signal }) => api.getWebhookSettings({ signal }),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSaveWebhookSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: WebhookSettings) => api.saveWebhookSettings(settings),
    onSuccess: (saved: WebhookSettings) => {
      queryClient.setQueryData(webhookKeys.webhookSettings, saved);
    },
  });
}
