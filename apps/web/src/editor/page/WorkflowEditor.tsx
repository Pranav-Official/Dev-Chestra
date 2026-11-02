import type { ProjectView } from "@devchestra/api";
import { isApiError } from "@devchestra/api";
import type { Issue, WorkflowNode } from "@devchestra/schema";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBlocker, useNavigate } from "react-router-dom";
import { useStore } from "zustand";
import { Topbar } from "../../shell/Topbar.js";
import { ProviderStateProvider } from "../../ui/providerState.js";
import {
  currentEtagFrom,
  describeWorkflowError,
  isConflictError,
  workflowApi,
} from "../api/workflowApi.js";
import { isDirty, WorkflowAutosave } from "../autosave.js";
import { EditorCanvas, NodePalette } from "../canvas/index.js";
import { ConfirmDialog } from "../controls/ConfirmDialog.js";
import { RunDialog, type RunPreparation } from "../controls/RunDialog.js";
import { Inspector } from "../inspector/index.js";
import { useAvailableClis } from "../inspector/model/useAvailableClis.js";
import type { BufferValidity } from "../inspector/types.js";
import { createEditorModel } from "../model/index.js";
import type { CommandOutcome } from "../model/types.js";
import { PollTriggerControl } from "../poll/PollTriggerControl.js";
import { PROBE_NAME_DEFAULT } from "../poll/probe.js";
import { WebhookTriggerControl } from "../webhook/WebhookTriggerControl.js";
import { EditorHeader } from "./EditorHeader.js";
import { useEditorValidation } from "./useEditorValidation.js";

type ConflictAction = "reload" | "overwrite";

export function WorkflowEditor({
  project,
  workflowId,
  document,
  onReloaded,
}: {
  project: ProjectView;
  workflowId: string;
  document: import("../api/workflowApi.js").WorkflowDocument;
  onReloaded: (document: import("../api/workflowApi.js").WorkflowDocument) => void;
}) {
  const pid = project.id;
  const navigate = useNavigate();
  const [model] = useState(() => createEditorModel(document.workflow));
  const file = useStore(model, (state) => state.file);
  const selection = useStore(model, (state) => state.selection);
  const revision = useStore(model, (state) => state.revision);
  const canUndo = useStore(model, (state) => state.past.length > 0);
  const canRedo = useStore(model, (state) => state.future.length > 0);

  const [controller] = useState(() => {
    const autosave = new WorkflowAutosave({
      docId: `${pid}/${workflowId}`,
      contentDebounceMs: 600,
      layoutDebounceMs: 5_000,
      save: async (request) => {
        try {
          const saved = await workflowApi.save(pid, workflowId, {
            workflow: request.workflow,
            baseEtag: request.baseEtag,
            signal: request.signal,
          });
          return { ok: true, etag: saved.etag, validation: saved.validation };
        } catch (error) {
          if (isConflictError(error)) {
            return {
              ok: false,
              kind: "conflict",
              message: describeWorkflowError(error),
              currentEtag: currentEtagFrom(error),
            };
          }
          return {
            ok: false,
            kind: "error",
            message: describeWorkflowError(error),
            code: isApiError(error) ? error.code : null,
          };
        }
      },
    });
    autosave.reset({ workflow: document.workflow, etag: document.etag });
    return autosave;
  });
  const autosave = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const [buffer, setBuffer] = useState<BufferValidity>({ valid: true });
  const [notice, setNotice] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [loopBodyOpenRequest, setLoopBodyOpenRequest] = useState<string | null>(null);
  const clearLoopBodyOpenRequest = useCallback(() => setLoopBodyOpenRequest(null), []);
  const [runOpen, setRunOpen] = useState(false);
  const [conflictAction, setConflictAction] = useState<ConflictAction | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const lastAck = useRef(0);
  const { clis } = useAvailableClis();
  const providerState = useMemo(
    () => ({ isDisabled: (cli: string) => clis.some((item) => item.id === cli && !item.enabled) }),
    [clis],
  );
  const disabledClis = useMemo(
    () => clis.filter((item) => !item.enabled).map((item) => item.id),
    [clis],
  );
  const validation = useEditorValidation(file, revision, disabledClis);

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (autosave.savedRevision > lastAck.current) {
      lastAck.current = autosave.savedRevision;
      model.getState().markSaved(autosave.savedRevision);
    }
  }, [autosave.savedRevision, model]);

  const selectedNodeId = selection?.kind === "node" ? selection.nodeId : null;
  const lastSession = useRef("");
  useEffect(() => {
    const session = `${file.id}:${selectedNodeId ?? "none"}`;
    if (lastSession.current === session) return;
    lastSession.current = session;
    setBuffer({ valid: true });
    controller.setBlocked(false);
  }, [file.id, selectedNodeId, controller]);

  const commit = useCallback(
    (outcome: CommandOutcome) => {
      if (!outcome.ok) {
        setNotice(outcome.error);
        return;
      }
      if (outcome.change !== null) controller.change(outcome.state.file, outcome.change);
    },
    [controller],
  );

  const changeRouting = useCallback(
    (nodeId: string, patch: Partial<WorkflowNode>, removeEdgeIds: readonly string[]) => {
      commit(model.getState().updateRouting(nodeId, patch, removeEdgeIds));
    },
    [commit, model],
  );

  const undo = useCallback(() => {
    commit(model.getState().undo());
  }, [commit, model]);
  const redo = useCallback(() => {
    commit(model.getState().redo());
  }, [commit, model]);

  const onBufferValidityChange = useCallback(
    (state: BufferValidity) => {
      setBuffer(state);
      controller.setBlocked(!state.valid, state.reason);
    },
    [controller],
  );

  const dirty = isDirty(autosave) || buffer.valid === false;
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const save = useCallback(async (): Promise<boolean> => {
    const ok = await controller.saveNow();
    if (ok) {
      lastAck.current = controller.getSnapshot().savedRevision;
      model.getState().markSaved(controller.getSnapshot().savedRevision);
    }
    return ok;
  }, [controller, model]);

  const prepareRun = useCallback(async (): Promise<RunPreparation> => {
    if (buffer.valid === false) {
      return { ok: false, message: buffer.reason ?? "Fix the invalid form buffer before running." };
    }
    const saved = await save();
    if (!saved) {
      const snapshot = controller.getSnapshot();
      return {
        ok: false,
        message:
          snapshot.error ??
          "The workflow could not be saved. Resolve the save error or conflict before running.",
      };
    }
    const snapshot = controller.getSnapshot();
    if (snapshot.etag === null)
      return { ok: false, message: "The workflow has no saved revision." };
    try {
      const report = await workflowApi.validate(pid, workflowId, model.getFile());
      if (!report.ok) {
        return {
          ok: false,
          message: `Server validation failed: ${report.errors[0]?.message ?? "unknown error"}`,
        };
      }
    } catch (error) {
      return { ok: false, message: describeWorkflowError(error) };
    }
    return { ok: true, etag: snapshot.etag };
  }, [buffer, controller, model, pid, save, workflowId]);

  const reloadFromServer = async (): Promise<void> => {
    setConflictBusy(true);
    setConflictError(null);
    try {
      const fresh = await workflowApi.get(pid, workflowId);
      setConflictAction(null);
      onReloaded(fresh);
    } catch (error) {
      setConflictError(describeWorkflowError(error));
    } finally {
      setConflictBusy(false);
    }
  };

  const overwriteServer = async (): Promise<void> => {
    setConflictBusy(true);
    setConflictError(null);
    try {
      const fresh = await workflowApi.get(pid, workflowId);
      controller.setBaseEtag(fresh.etag);
      const ok = await save();
      if (ok) {
        setConflictAction(null);
        setNotice("Overwrote the file with this editor's saved revision.");
      } else {
        const snapshot = controller.getSnapshot();
        setConflictError(
          snapshot.status === "conflict"
            ? "The file changed again while overwriting. Re-read it before trying once more."
            : (snapshot.error ?? "The overwrite failed."),
        );
      }
    } catch (error) {
      setConflictError(describeWorkflowError(error));
    } finally {
      setConflictBusy(false);
    }
  };

  const node =
    selectedNodeId === null
      ? null
      : (file.graph.nodes.find((item) => item.id === selectedNodeId) ?? null);
  // Derived probe selection: `${startId}::probe` edits start.polling.probe with
  // the normal Agent/Shell forms. The probe never enters the saved graph.
  const probeSelection =
    node === null && selectedNodeId !== null && selectedNodeId.endsWith("::probe")
      ? (() => {
          const startId = selectedNodeId.slice(0, -"::probe".length);
          const start = file.graph.nodes.find((item) => item.id === startId);
          if (start === undefined || start.type !== "start" || start.polling?.enabled !== true) {
            return null;
          }
          const probe = start.polling.probe;
          const synthetic =
            probe.type === "agent"
              ? {
                  id: "probe",
                  type: "agent",
                  name: probe.name ?? PROBE_NAME_DEFAULT,
                  cli: probe.cli,
                  ...(probe.model === undefined ? {} : { model: probe.model }),
                  ...(probe.prompt === undefined ? {} : { prompt: probe.prompt }),
                  permissions: probe.permissions ?? { network: true, write: [], shell: true },
                  ...(probe.mcpServers === undefined ? {} : { mcpServers: probe.mcpServers }),
                  ...(probe.limits === undefined ? {} : { limits: probe.limits }),
                  ...(probe.cliOptions === undefined ? {} : { cliOptions: probe.cliOptions }),
                  ...(probe.env === undefined ? {} : { env: probe.env }),
                  ...(probe.supervise === undefined ? {} : { supervise: probe.supervise }),
                  ...(probe.ui === undefined ? {} : { ui: probe.ui }),
                  output: { type: "object", additionalProperties: true },
                }
              : {
                  id: "probe",
                  type: "shell",
                  name: probe.name ?? PROBE_NAME_DEFAULT,
                  command: probe.command,
                  ...(probe.timeoutMin === undefined ? {} : { timeoutMin: probe.timeoutMin }),
                  ...(probe.env === undefined ? {} : { env: probe.env }),
                  ...(probe.supervise === undefined ? {} : { supervise: probe.supervise }),
                  ...(probe.ui === undefined ? {} : { ui: probe.ui }),
                };
          return { startId, start, probe, synthetic: synthetic as WorkflowNode };
        })()
      : null;
  const activeNode = probeSelection?.synthetic ?? node;
  const issues: readonly Issue[] = validation.report
    ? [...validation.report.errors, ...validation.report.warnings]
    : [];
  const inspectorIssues: readonly Issue[] =
    probeSelection === null
      ? issues
      : issues
          .filter((issue) => {
            if (issue.nodeId !== probeSelection.startId) return false;
            if (issue.code === "E_POLL_PROBE") return true;
            const pointer = issue.pointer;
            return typeof pointer === "string" && pointer.includes("/polling/probe");
          })
          .map((issue) => ({ ...issue, nodeId: "probe" }));
  // Arming reads the saved file, so it waits for a clean save; the server still validates.
  const armBlockedReason = isDirty(autosave)
    ? "Save your changes first. Arming uses the saved file."
    : buffer.valid === false
      ? "Fix the invalid form first, then save."
      : validation.report?.ok === false
        ? "Fix the validation errors first, then save."
        : null;
  // The polling control only mounts while the start node declares polling.
  // Arming is blocked while edits are unsaved, so the live probe type matches
  // the saved one whenever arming is allowed.
  const startNode = file.graph.nodes.find((node) => node.type === "start");
  const pollProbeType =
    startNode !== undefined && startNode.type === "start" && startNode.polling?.enabled === true
      ? startNode.polling.probe.type
      : null;
  const pollingDeclared = pollProbeType !== null;

  return (
    <div className="editor-page" data-testid="editor-page" data-workflow-id={workflowId}>
      <Topbar
        crumbs={[
          { label: "Projects", to: "/" },
          { label: project.name, to: `/p/${pid}/workflows` },
          { label: file.name.trim() === "" ? workflowId : file.name },
        ]}
        actions={
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => navigate(`/p/${pid}/workflows`)}
          >
            All workflows
          </button>
        }
      />
      <EditorHeader
        file={file}
        autosave={autosave}
        validation={validation}
        buffer={buffer}
        canUndo={canUndo}
        canRedo={canRedo}
        issuesOpen={issuesOpen}
        onToggleIssues={() => setIssuesOpen((open) => !open)}
        onChangeMeta={(patch) => commit(model.getState().apply({ kind: "updateWorkflow", patch }))}
        onUndo={undo}
        onRedo={redo}
        onSave={() => void save()}
        onRun={() => setRunOpen(true)}
        webhook={
          <WebhookTriggerControl
            projectId={pid}
            workflowId={workflowId}
            savedRevision={autosave.savedRevision}
            armBlockedReason={armBlockedReason}
          />
        }
        poll={
          pollingDeclared && pollProbeType !== null ? (
            <PollTriggerControl
              projectId={pid}
              workflowId={workflowId}
              savedRevision={autosave.savedRevision}
              armBlockedReason={armBlockedReason}
              probeType={pollProbeType}
            />
          ) : undefined
        }
      />

      {autosave.status === "conflict" ? (
        <div className="banner amber" role="alert" data-testid="conflict-banner">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            <b>This workflow changed on disk.</b> Autosave and running are stopped. Reload the
            server version, or overwrite it with your local revision.
          </span>
          <span className="sp" />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setConflictError(null);
              setConflictAction("reload");
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
            Reload from server
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setConflictError(null);
              setConflictAction("overwrite");
            }}
          >
            Overwrite file
          </button>
        </div>
      ) : null}
      {autosave.status === "error" ? (
        <div className="banner red" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{autosave.error ?? "Saving failed."} Your edits are still in the editor.</span>
          <span className="sp" />
          <button type="button" className="btn sm" onClick={() => void save()}>
            Retry save
          </button>
        </div>
      ) : null}
      {notice === null ? null : (
        <div className="banner blue" role="status">
          <Info size={16} aria-hidden="true" />
          <span>{notice}</span>
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="editor-workspace">
        <ProviderStateProvider value={providerState}>
          <div className="editor-canvas-host">
            <NodePalette file={file} onAdd={(type) => commit(model.getState().addNode(type))} />
            <EditorCanvas
              onLoopOpen={setLoopBodyOpenRequest}
              file={file}
              selection={selection}
              issues={issues}
              onSelectionChange={(next) => model.getState().select(next)}
              onChange={(next, change) => {
                const before = model.getState().revision;
                const outcome = model.getState().applyDocumentChange(next, change);
                if (!outcome.ok) {
                  setNotice(outcome.error);
                  return;
                }
                if (outcome.change !== null && outcome.state.revision !== before) {
                  controller.change(outcome.state.file, outcome.change);
                }
              }}
              onConnectionRejected={(message) => setNotice(message)}
              onUndo={undo}
              onRedo={redo}
            />
          </div>
          <Inspector
            loopBodyOpenRequested={
              probeSelection !== null
                ? false
                : (node?.type === "loop" || node?.type === "foreach") &&
                  loopBodyOpenRequest === node.id
            }
            onLoopBodyOpenHandled={clearLoopBodyOpenRequest}
            node={activeNode}
            projectId={pid}
            issues={inspectorIssues}
            graph={file.graph}
            edges={file.graph.edges}
            probeMode={probeSelection !== null}
            onSelectProbe={(probeNodeId) =>
              model.getState().select({ kind: "node", nodeId: probeNodeId })
            }
            onPatch={(nodeId, patch) => {
              if (probeSelection !== null) {
                const current = probeSelection.probe;
                const record = { ...(patch as Record<string, unknown>) };
                delete record.id;
                delete record.type;
                delete record.output;
                delete record.workspace;
                delete record.context;
                delete record.promptFile;
                delete record.allowFailure;
                delete record.ui;
                const nextProbe = { ...current, ...record } as typeof current;
                (nextProbe as { id: string }).id = "probe";
                commit(
                  model.getState().updateNode(probeSelection.startId, {
                    polling: { ...probeSelection.start.polling, probe: nextProbe },
                  } as Partial<WorkflowNode>),
                );
                return;
              }
              commit(model.getState().updateNode(nodeId, patch));
            }}
            onRoutingChange={changeRouting}
            onBufferValidityChange={onBufferValidityChange}
          />
        </ProviderStateProvider>
      </div>

      <RunDialog
        open={runOpen}
        projectId={pid}
        workflowId={workflowId}
        file={file}
        validation={validation.current ? validation.report : null}
        onClose={() => setRunOpen(false)}
        onPrepare={prepareRun}
        onStarted={(runId) => {
          setRunOpen(false);
          navigate(`/p/${pid}/r/${runId}`);
        }}
      />

      <ConfirmDialog
        open={conflictAction === "reload"}
        title="Reload from server"
        message="Discard every local edit in this editor and load the current file from disk?"
        confirmLabel="Reload and discard"
        danger
        busy={conflictBusy}
        onCancel={() => {
          if (conflictBusy) return;
          setConflictAction(null);
          setConflictError(null);
        }}
        onConfirm={() => void reloadFromServer()}
      >
        {conflictError === null ? null : (
          <p className="editor-form-error" role="alert">
            {conflictError}
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={conflictAction === "overwrite"}
        title="Overwrite file"
        message="Replace the version on disk with this editor's local revision? This does not merge the other change."
        confirmLabel="Overwrite file"
        danger
        busy={conflictBusy}
        onCancel={() => {
          if (conflictBusy) return;
          setConflictAction(null);
          setConflictError(null);
        }}
        onConfirm={() => void overwriteServer()}
      >
        {conflictError === null ? null : (
          <p className="editor-form-error" role="alert">
            {conflictError}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="Leave this workflow?"
        message="This editor has unsaved changes. Leaving now discards them."
        confirmLabel="Discard changes"
        cancelLabel="Stay"
        danger
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
