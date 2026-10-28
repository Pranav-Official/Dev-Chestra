import { FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { classifyError } from "../../api/client.js";
import { useRegisterProject } from "../../api/hooks.js";
import { Dialog } from "./Dialog.js";

export function AddProjectDialog({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  onRegistered: (projectId: string) => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const register = useRegisterProject();

  useEffect(() => {
    if (!open) return;
    setPath("");
    setError(null);
  }, [open]);

  const submit = async (): Promise<void> => {
    const value = path.trim();
    if (value === "") {
      setError("Enter the absolute path of an existing folder.");
      return;
    }
    setError(null);
    try {
      const project = await register.mutateAsync(value);
      onRegistered(project.id);
    } catch (failure) {
      setError(classifyError(failure).message);
    }
  };

  return (
    <Dialog
      open={open}
      title="Add project"
      description="Register an existing folder. DevChestra stores its own data elsewhere; it does not create or modify project files here."
      onClose={onClose}
      testId="add-project-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={register.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void submit()}
            disabled={register.isPending || path.trim() === ""}
          >
            <FolderPlus size={14} aria-hidden="true" />
            {register.isPending ? "Registering…" : "Register project"}
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
          <span className="editor-field-label">Project path</span>
          <input
            className="input"
            value={path}
            aria-label="Project path"
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/project"
            spellCheck={false}
            autoComplete="off"
            disabled={register.isPending}
          />
          <span className="editor-field-hint">
            The folder must already exist and must not contain the DevChestra data directory.
          </span>
        </label>
        {error === null ? null : (
          <p className="editor-form-error" role="alert" data-testid="project-register-error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
