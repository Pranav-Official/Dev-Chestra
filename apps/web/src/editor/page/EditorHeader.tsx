import type { Issue, WorkflowFile } from "@devchestra/schema";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Play,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AutosaveSnapshot } from "../autosave.js";
import type { BufferValidity } from "../inspector/types.js";
import type { WorkflowMetaPatch } from "../model/types.js";
import type { EditorValidation } from "./useEditorValidation.js";

function saveLabel(snapshot: AutosaveSnapshot): string {
  switch (snapshot.status) {
    case "loading":
      return "Loading…";
    case "clean":
    case "saved":
      return "Saved";
    case "dirty":
      return "Unsaved";
    case "saving":
      return "Saving…";
    case "error":
      return "Save failed";
    case "conflict":
      return "Conflict";
    case "blocked":
      return "Fix invalid form";
    default:
      return snapshot.status;
  }
}

function validationLabel(validation: EditorValidation): string {
  if (!validation.current || validation.report === null) return "Checking…";
  if (!validation.report.ok) {
    const count = validation.report.errors.length;
    return `${count} ${count === 1 ? "error" : "errors"}`;
  }
  if (validation.report.warnings.length > 0) {
    const count = validation.report.warnings.length;
    return `Valid · ${count} ${count === 1 ? "warning" : "warnings"}`;
  }
  return "Valid";
}

function IssueList({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="editor-issue-list" aria-label="Workflow issues">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.pointer ?? ""}:${issue.nodeId ?? ""}:${issue.message}`}>
          <span className={`pill ${issue.severity === "error" ? "red" : "amber"}`}>
            {issue.severity}
          </span>
          <span>{issue.message}</span>
          {issue.nodeId === undefined ? null : (
            <span className="faint mono">node {issue.nodeId}</span>
          )}
          {issue.pointer === undefined ? null : <span className="faint mono">{issue.pointer}</span>}
        </li>
      ))}
    </ul>
  );
}

export function EditorHeader({
  file,
  autosave,
  validation,
  buffer,
  canUndo,
  canRedo,
  issuesOpen,
  onToggleIssues,
  onChangeMeta,
  onUndo,
  onRedo,
  onSave,
  onRun,
  webhook,
  poll,
}: {
  file: WorkflowFile;
  autosave: AutosaveSnapshot;
  validation: EditorValidation;
  buffer: BufferValidity;
  canUndo: boolean;
  canRedo: boolean;
  issuesOpen: boolean;
  onToggleIssues: () => void;
  onChangeMeta: (patch: WorkflowMetaPatch) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onRun: () => void;
  /** The webhook trigger control, rendered by the page that owns the workflow ids. */
  webhook?: ReactNode;
  /** The polling trigger control, rendered next to the webhook control when declared. */
  poll?: ReactNode;
}) {
  const issues = validation.report
    ? [...validation.report.errors, ...validation.report.warnings]
    : [];
  const invalid = buffer.valid === false || !validation.current || validation.report?.ok === false;
  const conflict = autosave.status === "conflict";
  const runDisabled = invalid || conflict;
  const saveDisabled =
    autosave.status === "saving" ||
    autosave.status === "blocked" ||
    autosave.status === "conflict" ||
    autosave.status === "loading";

  return (
    <header className="editor-header">
      <div className="editor-meta">
        <label className="editor-meta-name">
          <span className="sr-only">Workflow name</span>
          <input
            className="input"
            value={file.name}
            onChange={(event) => onChangeMeta({ name: event.target.value })}
            aria-label="Workflow name"
            maxLength={200}
          />
        </label>
        <label className="editor-meta-description">
          <span className="sr-only">Workflow description</span>
          <input
            className="input"
            value={file.description ?? ""}
            onChange={(event) => onChangeMeta({ description: event.target.value })}
            aria-label="Workflow description"
            placeholder="Optional description"
            maxLength={2_000}
          />
        </label>
      </div>

      <div className="editor-controls">
        <div className="editor-toolbar">
          {webhook === undefined && poll === undefined ? null : (
            <fieldset className="editor-triggers">
              <legend className="sr-only">Triggers</legend>
              {webhook}
              {poll}
            </fieldset>
          )}
          <div className="editor-actions">
            <fieldset className="editor-history">
              <legend className="sr-only">History</legend>
              <button
                type="button"
                className="btn icon ghost"
                onClick={onUndo}
                disabled={!canUndo}
                aria-label="Undo"
                title="Undo (Ctrl+Z)"
              >
                <Undo2 size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn icon ghost"
                onClick={onRedo}
                disabled={!canRedo}
                aria-label="Redo"
                title="Redo (Ctrl+Shift+Z)"
              >
                <Redo2 size={14} aria-hidden="true" />
              </button>
            </fieldset>
            <button type="button" className="btn" onClick={onSave} disabled={saveDisabled}>
              <Save size={14} aria-hidden="true" />
              Save
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onRun}
              disabled={runDisabled}
              title={
                conflict
                  ? "Resolve the file conflict before running."
                  : buffer.valid === false
                    ? (buffer.reason ?? "Fix the invalid form buffer before running.")
                    : !validation.current
                      ? "Wait for validation to finish."
                      : validation.report?.ok === false
                        ? "Fix validation errors before running."
                        : "Review inputs and start a run"
              }
            >
              <Play size={14} aria-hidden="true" />
              Run
            </button>
          </div>
        </div>

        <div className="editor-status">
          <span
            className={`pill editor-save-state ${
              autosave.status === "error" || conflict
                ? "red"
                : autosave.status === "saving" || autosave.status === "dirty"
                  ? "amber"
                  : "green"
            }`}
            data-testid="autosave-status"
            aria-live="polite"
          >
            {saveLabel(autosave)}
          </span>
          <button
            type="button"
            className={`pill ${validation.report?.ok === false ? "red" : validation.report?.ok ? "green" : ""}`}
            onClick={onToggleIssues}
            aria-expanded={issuesOpen}
            aria-controls="editor-issue-panel"
            data-testid="validation-chip"
          >
            {validation.report?.ok === false || !validation.current ? (
              <AlertTriangle size={12} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={12} aria-hidden="true" />
            )}
            {validationLabel(validation)}
            {issues.length > 0 ? (
              issuesOpen ? (
                <ChevronUp size={12} aria-hidden="true" />
              ) : (
                <ChevronDown size={12} aria-hidden="true" />
              )
            ) : null}
          </button>
        </div>
      </div>

      {buffer.valid === false ? (
        <p className="editor-banner-error" role="alert" data-testid="buffer-invalid">
          {buffer.reason ?? "A form buffer is invalid"}. Saving and running are blocked until it is
          fixed or the node is deselected.
        </p>
      ) : null}
      {autosave.status === "error" ? (
        <p className="editor-banner-error" role="alert">
          {autosave.error ?? "The last save failed."} Your edits are still here.
        </p>
      ) : null}

      {issuesOpen ? (
        <div id="editor-issue-panel" className="editor-issues" aria-live="polite">
          <h2>Issues</h2>
          {issues.length === 0 ? (
            <p className="muted">No validation issues.</p>
          ) : (
            <IssueList issues={issues} />
          )}
        </div>
      ) : null}
    </header>
  );
}
