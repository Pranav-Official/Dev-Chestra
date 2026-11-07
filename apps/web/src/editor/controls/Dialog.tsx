import { type ReactNode, useEffect, useId, useRef } from "react";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  wide?: boolean;
  workspace?: boolean;
  /** Extra class on the body, for a caller that owns the body's scrolling. */
  bodyClassName?: string;
  /**
   * Escape guard consulted only by the native `cancel` (Escape) path, never
   * by the X button. Return true to keep the dialog open — used when an
   * inner popover (e.g. the variable picker) handles Escape itself and must
   * close first.
   */
  cancelGuard?: () => boolean;
}

/**
 * Native modal dialog: focus trapping, ESC and focus return come from the
 * platform. The fallback keeps component tests working where jsdom lacks
 * `showModal`.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  testId,
  wide = false,
  workspace = false,
  bodyClassName,
  cancelGuard,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`editor-dialog${wide ? " wide" : ""}${workspace ? " workspace" : ""}`}
      aria-labelledby={titleId}
      {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      onCancel={(event) => {
        // React propagates nested dialog events even though native events do not bubble.
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        event.preventDefault();
        if (cancelGuard?.() === true) return;
        if (open) onClose();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        if (open) onClose();
      }}
    >
      <div className="editor-dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="btn icon sm ghost"
          aria-label="Close dialog"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {description === undefined ? null : (
        <p id={descriptionId} className="editor-dialog-description">
          {description}
        </p>
      )}
      <div
        className={`editor-dialog-body${bodyClassName === undefined ? "" : ` ${bodyClassName}`}`}
      >
        {children}
      </div>
      {footer === undefined ? null : <div className="editor-dialog-foot">{footer}</div>}
    </dialog>
  );
}
