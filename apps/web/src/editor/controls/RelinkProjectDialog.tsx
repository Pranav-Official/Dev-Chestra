import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { classifyError } from "../../api/client.js";
import { useRelinkProject } from "../../api/hooks.js";
import { Dialog } from "./Dialog.js";

export function RelinkProjectDialog({
  open,
  projectId,
  projectName,
  onClose,
  onRelinked,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onRelinked: () => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const relink = useRelinkProject(projectId);

  useEffect(() => {
    if (!open) return;
    setPath("");
    setError(null);
  }, [open]);

  const submit = async (): Promise<void> => {
    const value = path.trim();
    if (value === "") {
      setError("Enter the new absolute path of the existing folder.");
      return;
    }
    setError(null);
    try {
      await relink.mutateAsync(value);
      onRelinked();
    } catch (failure) {
      setError(classifyError(failure).message);
    }
  };

  return (
    <Dialog
      open={open}
      title={`Relink ${projectName}`}
      description="Choose the folder's current absolute path. Run history stays attached to this project."
      onClose={onClose}
      testId="relink-project-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={relink.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void submit()}
            disabled={relink.isPending || path.trim() === ""}
          >
            <Link2 size={14} aria-hidden="true" />
            {relink.isPending ? "Relinking…" : "Relink project"}
          </button>
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
          <span className="editor-field-label">New project path</span>
          <input
            className="input"
            value={path}
            aria-label="New project path"
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/the/moved/project"
            spellCheck={false}
            autoComplete="off"
            disabled={relink.isPending}
          />
        </label>
        {error === null ? null : (
          <p className="editor-form-error" role="alert" data-testid="project-relink-error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
