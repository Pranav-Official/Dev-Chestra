import type { ProjectWorkspacesResponse } from "@relay/api";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client.js";

export interface ProjectWorkspacesState {
  data: ProjectWorkspacesResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function describeWorkspaceError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "The workspace list could not be loaded.";
}

export function useProjectWorkspaces(projectId: string, open: boolean): ProjectWorkspacesState {
  const [data, setData] = useState<ProjectWorkspacesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit reload trigger.
  useEffect(() => {
    if (!open || projectId === "") {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .listProjectWorkspaces(projectId, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(describeWorkspaceError(failure));
        setData(null);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [open, projectId, attempt]);

  return { data, loading, error, reload };
}
