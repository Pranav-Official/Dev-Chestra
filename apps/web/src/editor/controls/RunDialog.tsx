import { isApiError, type RunWorkspaceSelection } from "@devchestra/api";
import {
  MODEL_TIER_LABELS,
  type ValidationReport,
  validateParams,
  type WorkflowFile,
  type WorkflowParam,
} from "@devchestra/schema";
import { AlertTriangle, ArrowLeft, Play, ShieldAlert, TerminalSquare } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { describeWorkflowError, workflowApi } from "../api/workflowApi.js";
import { Dialog } from "./Dialog.js";
import { RunWorkspaceChoice } from "./RunWorkspaceChoice.js";
import { useProjectWorkspaces } from "./useProjectWorkspaces.js";

export interface RunPreparation {
  ok: boolean;
  etag?: string;
  message?: string;
}

type ParamValue = string | boolean;

function initialValue(param: WorkflowParam): ParamValue {
  if (param.type === "boolean") {
    return typeof param.default === "boolean" ? param.default : false;
  }
  if (param.default !== undefined) return String(param.default);
  return "";
}

function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function RunDialog({
  open,
  projectId,
  workflowId,
  file,
  validation,
  onClose,
  onPrepare,
  onStarted,
}: {
  open: boolean;
  projectId: string;
  workflowId: string;
  file: WorkflowFile;
  validation: ValidationReport | null;
  onClose: () => void;
  onPrepare: () => Promise<RunPreparation>;
  onStarted: (runId: string) => void;
}) {
  const params = useMemo(() => {
    const startNode = file.graph.nodes.find((node) => node.type === "start");
    return startNode?.type === "start" ? startNode.params : [];
  }, [file]);
  const agents = useMemo(() => file.graph.nodes.filter((node) => node.type === "agent"), [file]);
  const shells = useMemo(() => file.graph.nodes.filter((node) => node.type === "shell"), [file]);
  const runNodes = useMemo(
    () => file.graph.nodes.filter((node) => node.type === "agent" || node.type === "shell"),
    [file],
  );
  const [values, setValues] = useState<Record<string, ParamValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<"params" | "review">("params");
  const [failure, setFailure] = useState<ReactNode>(null);
  const [pending, setPending] = useState(false);
  const [workspace, setWorkspace] = useState<RunWorkspaceSelection>({ mode: "project" });
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const workspaces = useProjectWorkspaces(projectId, open);
  const keyRef = useRef<string | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, ParamValue> = {};
    for (const param of params) next[param.name] = initialValue(param);
    setValues(next);
    setErrors({});
    setStep("params");
    setFailure(null);
    setPending(false);
    setWorkspace({ mode: "project" });
    setWorkspaceNotice(null);
    pendingRef.current = false;
    keyRef.current = newIdempotencyKey();
  }, [open, params]);

  useEffect(() => {
    const data = workspaces.data;
    if (!open || data === null) return;
    if (workspace.mode === "project") return;
    if (!data.git) {
      setWorkspace({ mode: "project" });
      setWorkspaceNotice(
        "This project no longer offers Git worktrees. Project root is now selected; review the run again.",
      );
      setStep("params");
      return;
    }
    if (workspace.mode !== "existing-worktree") return;
    const available = data.worktrees.some(
      (worktree) => worktree.path === workspace.path && worktree.path !== data.projectRoot,
    );
    if (available) return;
    setWorkspace({ mode: "project" });
    setWorkspaceNotice(
      "The selected worktree is no longer available. Project root is now selected; review the run again.",
    );
    setStep("params");
  }, [open, workspace, workspaces.data]);

  const typedParams = useMemo(() => {
    const result: Record<string, string | number | boolean> = {};
    const nextErrors: Record<string, string> = {};
    for (const param of params) {
      const raw = values[param.name] ?? initialValue(param);
      if (param.type === "boolean") {
        result[param.name] = raw === true;
        continue;
      }
      if (param.type === "string") {
        result[param.name] = String(raw);
        continue;
      }
      const text = String(raw);
      if (text === "") {
        if (param.required) nextErrors[param.name] = "Required.";
        continue;
      }
      if (param.type === "number") {
        const number = Number(text.trim());
        if (!Number.isFinite(number)) {
          nextErrors[param.name] = "Enter a finite number.";
          continue;
        }
        result[param.name] = number;
      } else if (param.type === "enum") {
        if (param.options !== undefined && !param.options.includes(text)) {
          nextErrors[param.name] = "Choose one of the listed options.";
          continue;
        }
        result[param.name] = text;
      }
    }
    return { params: result, errors: nextErrors };
  }, [params, values]);

  const workspaceReady =
    (workspace.mode !== "existing-worktree" || (workspace.path ?? "") !== "") &&
    (workspace.mode === "project" || workspaces.data === null || workspaces.data.git);
  const projectRoot = workspaces.data?.projectRoot ?? null;
  const selectedWorktree =
    workspace.mode === "existing-worktree"
      ? (workspaces.data?.worktrees.find((worktree) => worktree.path === workspace.path) ?? null)
      : null;

  const review = (): void => {
    setErrors(typedParams.errors);
    setFailure(null);
    if (Object.keys(typedParams.errors).length > 0) return;
    if (!workspaceReady) {
      setFailure(
        workspace.mode === "existing-worktree"
          ? "Choose an available existing worktree, or use the project root."
          : "The selected workspace is not available for this project.",
      );
      return;
    }
    const checked = validateParams(file, typedParams.params);
    if (!checked.ok) {
      setFailure(checked.errors[0]?.message ?? "The run parameters are invalid.");
      return;
    }
    setStep("review");
  };

  const start = async (): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    try {
      const prepared = await onPrepare();
      if (!prepared.ok || prepared.etag === undefined) {
        setFailure(prepared.message ?? "The workflow could not be saved and validated.");
        setStep("params");
        setPending(false);
        pendingRef.current = false;
        return;
      }
      const key = keyRef.current ?? newIdempotencyKey();
      keyRef.current = key;
      const result = await workflowApi.start(
        projectId,
        workflowId,
        { params: typedParams.params, etag: prepared.etag, workspace },
        { idempotencyKey: key },
      );
      onStarted(result.runId);
    } catch (error) {
      setFailure(
        isApiError(error) && error.code === "E_CLI_DISABLED" ? (
          <>
            {error.message}{" "}
            <a
              href={`/p/${projectId}/settings/providers`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Providers settings
            </a>
          </>
        ) : (
          describeWorkflowError(error)
        ),
      );
      setPending(false);
      pendingRef.current = false;
    }
  };

  const setValue = (name: string, value: ParamValue): void => {
    setValues((previous) => ({ ...previous, [name]: value }));
    setErrors((previous) => {
      if (previous[name] === undefined) return previous;
      const next = { ...previous };
      delete next[name];
      return next;
    });
  };

  const footer =
    step === "params" ? (
      <>
        <button type="button" className="btn" onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={review} disabled={!validation?.ok}>
          Review and run
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn" onClick={() => setStep("params")} disabled={pending}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void start()}
          disabled={pending || !workspaceReady}
        >
          <Play size={14} aria-hidden="true" />
          {pending ? "Starting…" : "Start run"}
        </button>
      </>
    );

  return (
    <Dialog
      open={open}
      wide
      title="Run workflow"
      description="Review inputs and effects. Starting a run is explicit; saving never starts one."
      onClose={pending ? () => undefined : onClose}
      testId="run-dialog"
      footer={footer}
    >
      {failure === null ? null : (
        <p className="editor-form-error" role="alert" data-testid="run-error">
          {failure}
        </p>
      )}
      {validation !== null && !validation.ok ? (
        <div className="note red" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Fix the {validation.errors.length} validation errors before running.</span>
        </div>
      ) : null}

      {step === "params" ? (
        <div className="editor-form">
          <RunWorkspaceChoice
            selection={workspace}
            onChange={(next) => {
              setWorkspace(next);
              setWorkspaceNotice(null);
            }}
            workspaces={workspaces}
            notice={workspaceNotice}
          />
          {params.length === 0 ? (
            <p className="muted">This workflow has no start parameters.</p>
          ) : (
            params.map((param) => {
              const value = values[param.name] ?? initialValue(param);
              const error = errors[param.name];
              const inputId = `run-param-${param.name}`;
              return (
                <label className="editor-field" key={param.name} htmlFor={inputId}>
                  <span className="editor-field-label">
                    {param.name}
                    {param.required ? <span className="faint"> · required</span> : null}
                    <span className="faint"> · {param.type}</span>
                  </span>
                  {param.type === "boolean" ? (
                    <span className="row" style={{ gap: 8 }}>
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={value === true}
                        onChange={(event) => setValue(param.name, event.target.checked)}
                        data-testid={`run-param-${param.name}`}
                      />
                      <span className="muted">{value === true ? "true" : "false"}</span>
                    </span>
                  ) : param.type === "enum" ? (
                    <select
                      id={inputId}
                      className="input"
                      value={String(value)}
                      onChange={(event) => setValue(param.name, event.target.value)}
                      data-testid={`run-param-${param.name}`}
                    >
                      <option value="">Select…</option>
                      {(param.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={inputId}
                      className="input"
                      type={param.type === "number" ? "number" : "text"}
                      value={String(value)}
                      onChange={(event) => setValue(param.name, event.target.value)}
                      data-testid={`run-param-${param.name}`}
                    />
                  )}
                  {param.default !== undefined ? (
                    <span className="editor-field-hint">Default: {String(param.default)}</span>
                  ) : null}
                  {error === undefined ? null : (
                    <span className="editor-field-error" role="alert">
                      {error}
                    </span>
                  )}
                </label>
              );
            })
          )}
        </div>
      ) : (
        <div className="run-review">
          <section>
            <h3>Execution workspace</h3>
            <div data-testid="run-workspace-review">
              {runNodes.length === 0 ? (
                <p className="muted">This workflow runs no agent or shell nodes.</p>
              ) : (
                <p>
                  All {runNodes.length}{" "}
                  {runNodes.length === 1 ? "agent and shell node" : "agent and shell nodes"} use one
                  workspace for this run.
                </p>
              )}
              {workspace.mode === "project" ? (
                <p>
                  The registered project root
                  {projectRoot === null ? "" : " "}
                  {projectRoot === null ? null : <span className="mono">{projectRoot}</span>} is
                  used directly. Agents and shell commands can read and edit project files; changes
                  are live in your checkout and nothing is committed automatically.
                </p>
              ) : workspace.mode === "new-worktree" ? (
                <p>
                  A new Git worktree is created under DevChestra's data directory when this run
                  starts, from the project's committed HEAD. Uncommitted and untracked project files
                  are not present. The run records its starting HEAD for evidence; your selected
                  checkout is never deleted or finalized.
                </p>
              ) : (
                <p>
                  The existing worktree at <span className="mono">{workspace.path ?? "—"}</span> is
                  used directly. Changes stay in that worktree, not the main checkout.
                  {selectedWorktree === null ? null : (
                    <>
                      {" "}
                      Current branch:{" "}
                      <span className="mono">{selectedWorktree.branch ?? "detached HEAD"}</span>,
                      HEAD <span className="mono">{selectedWorktree.head.slice(0, 12)}</span>
                      {selectedWorktree.detached ? " (detached)" : ""}.
                    </>
                  )}
                </p>
              )}
              <p className="muted">The workspace is fixed for this run and stored for resume.</p>
              {workspace.mode === "existing-worktree" ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={workspaces.reload}
                  disabled={pending || workspaces.loading}
                  data-testid="run-workspace-review-refresh"
                >
                  Refresh worktrees
                </button>
              ) : null}
              {workspaceNotice === null ? null : (
                <p className="editor-field-error" role="alert">
                  {workspaceNotice}
                </p>
              )}
            </div>
          </section>
          <section>
            <h3>Parameters</h3>
            {params.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <dl className="kv">
                {params.map((param) => (
                  <div key={param.name} className="contents">
                    <dt>{param.name}</dt>
                    <dd className="mono">{String(typedParams.params[param.name] ?? "—")}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section>
            <h3>
              <TerminalSquare size={14} aria-hidden="true" /> Shell commands
            </h3>
            {shells.length === 0 ? (
              <p className="muted">This workflow runs no shell commands.</p>
            ) : (
              <ul className="run-review-list">
                {shells.map((node) =>
                  node.type === "shell" ? (
                    <li key={node.id}>
                      <b>{node.name}</b>
                      <pre className="code">{node.command}</pre>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
          </section>
          <section>
            <h3>
              <ShieldAlert size={14} aria-hidden="true" /> Agent permissions
            </h3>
            {agents.length === 0 ? (
              <p className="muted">This workflow runs no agents.</p>
            ) : (
              <ul className="run-review-list">
                {agents.map((node) =>
                  node.type === "agent" ? (
                    <li key={node.id}>
                      <b>{node.name}</b> ·{" "}
                      <span className="mono">
                        {node.tier === undefined
                          ? node.cli
                          : `${MODEL_TIER_LABELS[node.tier]} tier`}
                      </span>
                      <div className="muted">
                        CLI tools: network {node.permissions.network ? "enabled" : "disabled"}
                        {"; write: "}
                        {node.permissions.write.length === 0
                          ? "none"
                          : node.permissions.write.join(", ")}
                      </div>
                      {node.permissions.shellPolicy === undefined ? null : (
                        <p className="muted">
                          Commands are filtered by shell policy. Allowed commands retain your
                          filesystem and network access, regardless of the CLI tool settings above.
                        </p>
                      )}
                    </li>
                  ) : null,
                )}
              </ul>
            )}
            <div className="note amber">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                DevChestra is not an OS sandbox; agent permission controls are advisory to the CLI.
                Starting a real-agent run uses your configured CLI account and may incur costs.
              </span>
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}
