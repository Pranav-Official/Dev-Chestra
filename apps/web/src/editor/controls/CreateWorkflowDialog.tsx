import type { WorkflowTemplate } from "@devchestra/api";
import { useQueryClient } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, classifyError } from "../../api/client.js";
import { queryKeys, useWorkflowGroups } from "../../api/hooks.js";
import { type WorkflowDocument, workflowApi } from "../api/workflowApi.js";
import { Dialog } from "./Dialog.js";

const ID_PATTERN = /^[a-z0-9-]{1,64}$/u;

export function CreateWorkflowDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (document: WorkflowDocument) => void;
}) {
  const groups = useWorkflowGroups(projectId, open);
  const client = useQueryClient();
  const [groupId, setGroupId] = useState("");
  const [created, setCreated] = useState<WorkflowDocument | null>(null);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [template, setTemplate] = useState<WorkflowTemplate>("blank");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setGroupId("");
    setCreated(null);
    setId("");
    setTemplate("blank");
    setError(null);
    setPending(false);
  }, [open]);

  const idInvalid = id !== "" && !ID_PATTERN.test(id);
  const canSubmit = name.trim() !== "" && !idInvalid && !pending && created === null;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const document = await workflowApi.create(projectId, {
        name: name.trim(),
        ...(id === "" ? {} : { id }),
        template,
      });
      if (groupId && groups.data) {
        try {
          const updated = await api.saveWorkflowGroups(
            projectId,
            {
              ...groups.data.document,
              memberships: { ...groups.data.document.memberships, [document.workflow.id]: groupId },
            },
            groups.data.etag,
          );
          client.setQueryData(queryKeys.groups(projectId), updated);
        } catch (failure) {
          setCreated(document);
          setError(`Workflow created ungrouped. ${classifyError(failure).message}`);
          void client.invalidateQueries({ queryKey: queryKeys.groups(projectId) });
          setPending(false);
          return;
        }
      }
      onCreated(document);
    } catch (failure) {
      setError(classifyError(failure).message);
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="New workflow"
      description="Creating a workflow opens it in the editor. It never starts a run."
      onClose={pending ? () => undefined : onClose}
      testId="create-workflow-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          {created ? (
            <button type="button" className="btn" onClick={() => onCreated(created)}>
              Open workflow
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              <FilePlus2 size={14} aria-hidden="true" />
              {pending ? "Creating…" : "Create workflow"}
            </button>
          )}
        </>
      }
    >
      <form
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="editor-field">
          <span className="editor-field-label">Name</span>
          <input
            className="input"
            value={name}
            aria-label="Name"
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
            disabled={pending}
          />
        </label>
        {groups.data && groups.data.document.groups.length > 0 ? (
          <label className="editor-field">
            <span className="editor-field-label">Group</span>
            <select
              className="input"
              value={groupId}
              disabled={pending || created !== null}
              onChange={(event) => setGroupId(event.target.value)}
            >
              <option value="">Ungrouped</option>
              {groups.data.document.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="editor-field">
          <span className="editor-field-label">Workflow id (optional)</span>
          <input
            className="input"
            value={id}
            aria-label="Workflow id (optional)"
            onChange={(event) => setId(event.target.value.trim())}
            placeholder="derived-from-name"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={idInvalid}
            disabled={pending}
          />
          <span className="editor-field-hint">
            Lowercase letters, digits and dashes; up to 64 characters. Leave blank to derive it from
            the name.
          </span>
          {idInvalid ? (
            <span className="editor-field-error" role="alert">
              Use lowercase letters, digits and dashes only.
            </span>
          ) : null}
        </label>
        <label className="editor-field">
          <span className="editor-field-label">Template</span>
          <select
            className="input"
            value={template}
            aria-label="Template"
            onChange={(event) => setTemplate(event.target.value as WorkflowTemplate)}
            disabled={pending}
          >
            <option value="blank">Blank</option>
            <option value="linear">Linear</option>
          </select>
          <span className="editor-field-hint">
            Blank starts with an empty canvas. Linear creates start → agent → shell → end with a
            codex agent.
          </span>
        </label>
        {error === null ? null : (
          <p className="editor-form-error" role="alert" data-testid="create-workflow-error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
