import type {
  EffectiveSettingsResponse,
  SettingsDocument,
  SettingsResponse,
  SettingsScopeValue,
} from "@devchestra/api";
import { isApiError } from "@devchestra/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.js";

/** Query keys for a project's settings files and the tier mapping a run would use. */
export const settingsKeys = {
  layer: (projectId: string, scope: SettingsScopeValue) =>
    ["project-settings", projectId, scope] as const,
  effective: (projectId: string) => ["project-settings", projectId, "effective"] as const,
};

export function useSettingsLayer(projectId: string, scope: SettingsScopeValue) {
  return useQuery({
    queryKey: settingsKeys.layer(projectId, scope),
    queryFn: ({ signal }) => api.getSettings(projectId, scope, { signal }),
    enabled: projectId !== "",
    // The draft is edited locally; refetching under it would reset the form.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useEffectiveSettings(projectId: string) {
  return useQuery({
    queryKey: settingsKeys.effective(projectId),
    queryFn: ({ signal }) => api.getEffectiveSettings(projectId, { signal }),
    enabled: projectId !== "",
    staleTime: 0,
    retry: false,
  });
}

/** Saves one settings file with the ETag it was loaded with; a stale ETag surfaces as a conflict. */
export function useSaveSettings(projectId: string, scope: SettingsScopeValue) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { document: SettingsDocument; etag: string }) =>
      api.saveSettings(projectId, scope, input.document, input.etag),
    onSuccess: (saved: SettingsResponse) => {
      queryClient.setQueryData(settingsKeys.layer(projectId, scope), saved);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.effective(projectId) });
    },
  });
}

/** True when a save lost to a change made on disk (or in another tab) since the file was loaded. */
export function isSettingsConflict(error: unknown): boolean {
  return isApiError(error) && (error.code === "E_CONFLICT" || error.status === 409);
}

export type { EffectiveSettingsResponse };
