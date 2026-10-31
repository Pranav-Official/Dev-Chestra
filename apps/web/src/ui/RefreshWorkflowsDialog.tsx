import type { WorkflowListResponse } from "@devchestra/api";
import { useQueryClient } from "@tanstack/react-query";
import { FileMinus2, FilePlus2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { classifyError } from "../api/client.js";
import { queryKeys } from "../api/hooks.js";
import { workflowApi } from "../editor/api/workflowApi.js";
import { Dialog } from "../editor/controls/Dialog.js";

interface Entry {
  id: string;
  name: string;
}

type Scan =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; fresh: WorkflowListResponse; added: Entry[]; removed: Entry[] };

/**
 * Compares the workflows the workspace is showing with the project's
 * `.devchestra/workflows` folder, and applies the difference only on Proceed.
 * The folder is the source of truth: nothing is stored or deleted here. A
 * removed workflow just leaves the list; its run history stays.
 */
export function RefreshWorkflowsDialog({
  projectId,
  projectName,
  open,
  onClose,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [scan, setScan] = useState<Scan>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the scan on Retry
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setScan({ state: "loading" });
    // Read straight from the API, not through the query cache, so cancelling
    // leaves what the sidebar shows exactly as it was.
    workflowApi.list(projectId, { limit: 200 }, { signal: controller.signal }).then(
      (fresh) => {
        const shown = client.getQueryData<WorkflowListResponse>(queryKeys.workflows(projectId));
        const before = new Map((shown?.items ?? []).map((item) => [item.id, item.name]));
        const after = new Map(fresh.items.map((item) => [item.id, item.name]));
        const added = fresh.items
          .filter((item) => shown !== undefined && !before.has(item.id))
          .map((item) => ({ id: item.id, name: item.name }));
        const removed = (shown?.items ?? [])
          .filter((item) => !after.has(item.id))
          .map((item) => ({ id: item.id, name: item.name }));
        setScan({ state: "ready", fresh, added, removed });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setScan({ state: "error", message: classifyError(error).message });
      },
    );
    return () => controller.abort();
  }, [open, projectId, client, attempt]);

  const proceed = (scanned: Extract<Scan, { state: "ready" }>): void => {
    client.setQueryData(queryKeys.workflows(projectId), scanned.fresh);
    void client.invalidateQueries({ queryKey: queryKeys.workflows(projectId) });
    // A workflow that was open in the editor and is now gone has nothing to show.
    const gone = scanned.removed.find((entry) =>
      location.pathname.startsWith(`/p/${projectId}/w/${entry.id}`),
    );
    if (gone) navigate(`/p/${projectId}/workflows`, { replace: true });
    onClose();
  };

  const ready = scan.state === "ready" ? scan : null;
  const upToDate = ready !== null && ready.added.length === 0 && ready.removed.length === 0;

  return (
    <Dialog
      open={open}
      title="Refresh workflows"
      description={`Compare ${projectName}'s .devchestra/workflows folder with your workspace.`}
      onClose={onClose}
      testId="refresh-workflows-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {upToDate ? "Close" : "Cancel"}
          </button>
          {ready !== null && !upToDate ? (
            <button type="button" className="btn" onClick={() => proceed(ready)}>
              Proceed
            </button>
          ) : null}
          {scan.state === "error" ? (
            <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          ) : null}
        </>
      }
    >
      {scan.state === "loading" ? (
        <p className="faint" role="status">
          Scanning the workflows folder…
        </p>
      ) : null}
      {scan.state === "error" ? <p role="alert">{scan.message}</p> : null}
      {upToDate ? (
        <p role="status">Workflows are up to date. Nothing was added or removed.</p>
      ) : null}
      {ready !== null && !upToDate ? (
        <div className="refresh-diff">
          <DiffGroup title="Added" entries={ready.added} kind="added" />
          <DiffGroup title="Removed" entries={ready.removed} kind="removed" />
          {ready.removed.length > 0 ? (
            <p className="faint">Run history for removed workflows is kept.</p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function DiffGroup({
  title,
  entries,
  kind,
}: {
  title: string;
  entries: Entry[];
  kind: "added" | "removed";
}) {
  if (entries.length === 0) return null;
  const Icon = kind === "added" ? FilePlus2 : FileMinus2;
  return (
    <section aria-label={`${title} workflows`}>
      <h3 className="refresh-diff-title">
        {title} ({entries.length})
      </h3>
      <ul className={`refresh-diff-list ${kind}`}>
        {entries.map((entry) => (
          <li key={entry.id}>
            <Icon size={14} aria-hidden="true" />
            <span className="nm">{entry.name}</span>
            <span className="faint mono">{entry.id}.json</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
