import { AlertTriangle, Link2 } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { classifyError } from "../../api/client.js";
import { useBootstrap, useWorkflowDocument } from "../../api/hooks.js";
import { Topbar } from "../../shell/Topbar.js";
import { AuthState, LoadingState, NetworkError, NotFoundState } from "../../ui/states.js";
import type { WorkflowDocument } from "../api/workflowApi.js";
import { RelinkProjectDialog } from "../controls/RelinkProjectDialog.js";
import { WorkflowEditor } from "./WorkflowEditor.js";

export function EditorRoute() {
  const { pid = "", wid = "" } = useParams();
  return <EditorLoader key={`${pid}:${wid}`} pid={pid} wid={wid} />;
}

function EditorLoader({ pid, wid }: { pid: string; wid: string }) {
  const bootstrap = useBootstrap();
  const documentQuery = useWorkflowDocument(pid, wid);
  const [override, setOverride] = useState<WorkflowDocument | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const project = bootstrap.data?.projects.find((item) => item.id === pid);
  const document = override ?? documentQuery.data;
  const crumbs = [
    { label: "Projects", to: "/" },
    { label: project?.name ?? pid, to: `/p/${pid}/workflows` },
    { label: document?.workflow.name ?? wid },
  ];

  if (bootstrap.isPending) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <LoadingState label="Loading the editor…" />
        </div>
      </>
    );
  }
  const bootstrapFailure = bootstrap.error ? classifyError(bootstrap.error) : null;
  if (bootstrapFailure?.kind === "auth") {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <AuthState />
        </div>
      </>
    );
  }
  if (bootstrapFailure) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <NetworkError
            message={bootstrapFailure.message}
            onRetry={() => void bootstrap.refetch()}
          />
        </div>
      </>
    );
  }
  if (project === undefined) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <NotFoundState
            title="Project not found"
            message={`No registered project has the id "${pid}".`}
            backTo="/"
            backLabel="Back to projects"
          />
        </div>
      </>
    );
  }

  if (project.missing) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content" data-testid="missing-project-editor">
          <div className="banner amber" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              <b>{project.name}</b> is registered, but its folder is missing. Relink it before
              editing workflows.
            </span>
            <span className="sp" />
            <button type="button" className="btn sm" onClick={() => setRelinkOpen(true)}>
              <Link2 size={13} aria-hidden="true" />
              Relink folder
            </button>
          </div>
        </div>
        <RelinkProjectDialog
          open={relinkOpen}
          projectId={pid}
          projectName={project.name}
          onClose={() => setRelinkOpen(false)}
          onRelinked={() => {
            setRelinkOpen(false);
            void bootstrap.refetch();
            void documentQuery.refetch();
          }}
        />
      </>
    );
  }

  if (documentQuery.isPending && document === undefined) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <LoadingState label="Loading the workflow file…" />
        </div>
      </>
    );
  }
  if (documentQuery.error && document === undefined) {
    const failure = classifyError(documentQuery.error);
    if (failure.kind === "auth") {
      return (
        <>
          <Topbar crumbs={crumbs} />
          <div className="content">
            <AuthState />
          </div>
        </>
      );
    }
    if (failure.kind === "notfound") {
      return (
        <>
          <Topbar crumbs={crumbs} />
          <div className="content">
            <NotFoundState
              title="Workflow not found"
              message={`No workflow "${wid}" exists in this project.`}
              backTo={`/p/${pid}/workflows`}
              backLabel="Back to workflows"
            />
          </div>
        </>
      );
    }
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <NetworkError message={failure.message} onRetry={() => void documentQuery.refetch()} />
        </div>
      </>
    );
  }
  if (document === undefined) return null;

  return (
    <WorkflowEditor
      key={`${pid}:${wid}:${epoch}`}
      project={project}
      workflowId={wid}
      document={document}
      onReloaded={(fresh) => {
        setOverride(fresh);
        setEpoch((value) => value + 1);
      }}
    />
  );
}
