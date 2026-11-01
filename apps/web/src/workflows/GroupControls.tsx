import type { WorkflowGroupsDocument, WorkflowGroupsResponse } from "@devchestra/api";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, classifyError } from "../api/client.js";
import { queryKeys } from "../api/hooks.js";
import { Dialog } from "../editor/controls/Dialog.js";

export function GroupControls({
  projectId,
  groups,
}: {
  projectId: string;
  groups: WorkflowGroupsResponse;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async (document: WorkflowGroupsDocument) => {
    setPending(true);
    setError(null);
    try {
      const result = await api.saveWorkflowGroups(projectId, document, groups.etag);
      client.setQueryData(queryKeys.groups(projectId), result);
      setEditing(null);
      setDeleting(null);
    } catch (failure) {
      setError(classifyError(failure).message);
      void client.invalidateQueries({ queryKey: queryKeys.groups(projectId) });
    } finally {
      setPending(false);
    }
  };
  const open = (id: string) => {
    setEditing(id);
    setName(groups.document.groups.find((g) => g.id === id)?.name ?? "");
    setError(null);
  };
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id =
      editing === "new"
        ? `grp_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) => v.toString(16).padStart(2, "0")).join("")}`
        : editing;
    if (!id) return;
    if (
      groups.document.groups.some(
        (g) =>
          g.id !== id && g.name.toLocaleLowerCase("en-US") === trimmed.toLocaleLowerCase("en-US"),
      )
    ) {
      setError("A group with this name already exists.");
      return;
    }
    const next = groups.document.groups.filter((g) => g.id !== id);
    void save({ ...groups.document, groups: [...next, { id, name: trimmed }] });
  };
  return (
    <>
      <button className="btn sm" type="button" onClick={() => open("new")}>
        New group
      </button>
      {groups.document.groups.map((g) => (
        <span key={g.id} className="row" style={{ display: "inline-flex", gap: 4, marginLeft: 8 }}>
          <span>{g.name}</span>
          <button className="btn sm" type="button" onClick={() => open(g.id)}>
            Rename
          </button>
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              setDeleting(g.id);
              setError(null);
            }}
          >
            Delete
          </button>
        </span>
      ))}
      <Dialog
        open={editing !== null}
        title={editing === "new" ? "New group" : "Rename group"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              disabled={pending || !name.trim()}
              onClick={submit}
            >
              Save
            </button>
          </>
        }
      >
        <label className="editor-field">
          <span>Group name</span>
          <input
            className="input"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
      </Dialog>
      <Dialog
        open={deleting !== null}
        title="Delete group"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              disabled={pending}
              onClick={() =>
                void save({
                  ...groups.document,
                  groups: groups.document.groups.filter((g) => g.id !== deleting),
                  memberships: Object.fromEntries(
                    Object.entries(groups.document.memberships).filter(([, id]) => id !== deleting),
                  ),
                })
              }
            >
              Delete group
            </button>
          </>
        }
      >
        <p>Workflows in this group will move to Ungrouped.</p>
        {error && <p role="alert">{error}</p>}
      </Dialog>
    </>
  );
}

export function GroupSelect({
  projectId,
  workflowId,
  groups,
}: {
  projectId: string;
  workflowId: string;
  groups: WorkflowGroupsResponse;
}) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const move = async (id: string) => {
    const memberships = { ...groups.document.memberships };
    if (id) memberships[workflowId] = id;
    else delete memberships[workflowId];
    setPending(true);
    setError(null);
    try {
      client.setQueryData(
        queryKeys.groups(projectId),
        await api.saveWorkflowGroups(projectId, { ...groups.document, memberships }, groups.etag),
      );
    } catch (failure) {
      setError(classifyError(failure).message);
      void client.invalidateQueries({ queryKey: queryKeys.groups(projectId) });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <select
        className="input"
        aria-label={`Group for ${workflowId}`}
        value={groups.document.memberships[workflowId] ?? ""}
        disabled={pending}
        onChange={(e) => void move(e.target.value)}
      >
        <option value="">Ungrouped</option>
        {groups.document.groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
