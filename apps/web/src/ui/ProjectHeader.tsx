import { Folder, FolderGit2 } from "lucide-react";
import { Link } from "react-router-dom";

export function ProjectHeader({
  project,
  section,
}: {
  project: { id: string; name: string; path: string; kind: string };
  section: "workflows" | "runs";
}) {
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1>{project.name}</h1>
          <p className="mono">{project.path}</p>
        </div>
        <span className="chip" title={project.path}>
          {project.kind === "git" ? (
            <FolderGit2 size={12} aria-hidden="true" />
          ) : (
            <Folder size={12} aria-hidden="true" />
          )}
          {project.kind}
        </span>
      </div>
      <nav className="editor-subnav" aria-label="Project sections">
        <Link
          className={`tab${section === "workflows" ? " active" : ""}`}
          to={`/p/${project.id}/workflows`}
          aria-current={section === "workflows" ? "page" : undefined}
        >
          Workflows
        </Link>
        <Link
          className={`tab${section === "runs" ? " active" : ""}`}
          to={`/p/${project.id}/runs`}
          aria-current={section === "runs" ? "page" : undefined}
        >
          Runs
        </Link>
      </nav>
    </>
  );
}
