import { Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../../controls/Dialog.js";
import { useBufferFlag } from "../BufferContext.js";
import { useVariableField } from "./VariablePicker.js";

export type ExpandableMode = "template" | "expression" | "none";

export interface ExpandableTextareaProps {
  /** DOM id shared by the inline textarea and the expanded one (`${id}-expanded`). */
  id: string;
  /** Field label, used for the expand affordance and the dialog title. */
  label: string;
  /** Current field text (buffered text for buffered fields). */
  value: string;
  /** Original change handler (buffered `onChange` for buffered fields). */
  onCommit: (next: string) => void;
  /** Field-scoped validation; Apply is blocked while it fails. */
  validate?: (next: string) => string | null;
  /** Variable-picker mode; "none" renders no picker (literal-only fields). */
  mode: ExpandableMode;
  nodeId: string;
  /** Catalog field key for the picker. */
  field: string;
  /** Base test id for the inline picker button; the expanded one is `${base}-expanded`. */
  pickerTestId?: string | undefined;
  textareaTestId: string;
  rows?: number;
  className?: string;
  spellCheck?: boolean;
  maxLength?: number;
  placeholder?: string | undefined;
  disabled?: boolean;
  readOnly?: boolean;
  /** Underlying field error/help, mirrored inside the dialog. */
  error?: string | null | undefined;
  help?: string | undefined;
  /** Buffer key for buffered fields; an invalid expanded draft blocks Save/Run while open. */
  bufferKey?: string | undefined;
  describedBy?: string | undefined;
}

/**
 * Large-textarea wrapper with a subtle corner expand affordance. The expanded
 * dialog holds a **local draft**: Apply commits it through the original
 * `onCommit` handler, while Cancel, X and Escape discard it. Invalid drafts
 * disable Apply and keep the underlying value untouched.
 */
export function ExpandableTextarea({
  id,
  label,
  value,
  onCommit,
  validate,
  mode,
  nodeId,
  field,
  pickerTestId,
  textareaTestId,
  rows = 4,
  className = "inspector-input inspector-textarea",
  spellCheck,
  maxLength,
  placeholder,
  disabled = false,
  readOnly = false,
  error,
  help,
  bufferKey,
  describedBy,
}: ExpandableTextareaProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const openValueRef = useRef(value);
  const expandRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLTextAreaElement>(null);
  const inlineCaret = useRef<{ start: number; end: number } | null>(null);
  const expandedPickerOpen = useRef(false);
  const trackPickerOpen = useCallback((next: boolean) => {
    expandedPickerOpen.current = next;
  }, []);

  const inlineField = useVariableField({
    nodeId,
    field,
    mode: mode === "none" ? "template" : mode,
    value,
    commit: onCommit,
    testId: pickerTestId ?? `${textareaTestId}-variables`,
  });
  const expandedField = useVariableField({
    nodeId,
    field,
    mode: mode === "none" ? "template" : mode,
    value: draft,
    commit: setDraft,
    testId: `${pickerTestId ?? `${textareaTestId}-variables`}-expanded`,
    onOpenChange: trackPickerOpen,
  });

  const draftError = validate?.(draft) ?? null;
  const locked = disabled || readOnly;
  // While open, an invalid draft blocks Save/Run just like an invalid inline buffer.
  useBufferFlag(
    bufferKey === undefined ? `${textareaTestId}.expanded` : `${bufferKey}.expanded`,
    open && !locked ? draftError : null,
  );

  // External edits (undo/redo, node switch) resync the draft so it never goes stale.
  const resetKey = `${nodeId}:${field}`;
  const resetRef = useRef(resetKey);
  useEffect(() => {
    if (resetRef.current !== resetKey) {
      resetRef.current = resetKey;
      openValueRef.current = value;
      setDraft(value);
      return;
    }
    if (value === openValueRef.current) return;
    openValueRef.current = value;
    setDraft(value);
  }, [resetKey, value]);

  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    el.focus();
    try {
      const caret = inlineCaret.current ?? { start: el.value.length, end: el.value.length };
      el.setSelectionRange(caret.start, caret.end);
    } catch {
      // selection unsupported; focus alone is enough
    }
  }, [open]);

  const openDialog = (): void => {
    if (disabled) return;
    const el = inlineField.ref.current;
    if (el && el.ownerDocument.activeElement === el) {
      inlineCaret.current = {
        start: el.selectionStart ?? el.value.length,
        end: el.selectionEnd ?? el.value.length,
      };
    } else {
      inlineCaret.current = null;
    }
    openValueRef.current = value;
    setDraft(value);
    expandedPickerOpen.current = false;
    setOpen(true);
  };
  const closeDiscard = (): void => {
    setOpen(false);
    openValueRef.current = value;
    setDraft(value);
    requestAnimationFrame(() => expandRef.current?.focus());
  };
  const apply = (): void => {
    if (locked || draftError !== null) return;
    if (draft !== value) onCommit(draft);
    setOpen(false);
    requestAnimationFrame(() => expandRef.current?.focus());
  };

  const expandedId = `${id}-expanded`;
  const footer = locked ? (
    <button
      type="button"
      className="btn sm"
      data-testid={`${textareaTestId}-expanded-close`}
      onClick={closeDiscard}
    >
      Close
    </button>
  ) : (
    <>
      <button
        type="button"
        className="btn ghost sm"
        data-testid={`${textareaTestId}-expanded-cancel`}
        aria-label={`Cancel expanded ${label}`}
        onClick={closeDiscard}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn sm"
        data-testid={`${textareaTestId}-expanded-apply`}
        aria-label={`Apply expanded ${label}`}
        disabled={draftError !== null}
        onClick={apply}
      >
        Apply
      </button>
    </>
  );

  return (
    <>
      <div className="inspector-input-wrap">
        <textarea
          id={id}
          className={className}
          data-testid={textareaTestId}
          rows={rows}
          spellCheck={spellCheck}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onCommit(event.currentTarget.value)}
          {...inlineField.inputProps}
        />
        <div className="inspector-textarea-actions">
          <button
            ref={expandRef}
            type="button"
            className="inspector-icon-btn inspector-expand-btn"
            data-testid={`${textareaTestId}-expand`}
            aria-label={`Expand ${label}`}
            title={`Expand ${label}`}
            disabled={disabled}
            onClick={openDialog}
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
          {mode === "none" ? null : inlineField.picker}
        </div>
      </div>
      <Dialog
        open={open}
        title={`Edit ${label}`}
        description="Apply updates the field. Cancel, X or Escape discards expanded edits."
        onClose={closeDiscard}
        cancelGuard={() => expandedPickerOpen.current}
        wide
        testId={`${textareaTestId}-expanded-dialog`}
        footer={footer}
      >
        {open ? (
          <div className="expand-editor">
            {help === undefined ? null : <p className="inspector-help">{help}</p>}
            <div className="inspector-input-wrap">
              <textarea
                id={expandedId}
                ref={(el) => {
                  dialogRef.current = el;
                  expandedField.ref.current = el;
                }}
                className={`${className} expand-editor-textarea`}
                data-testid={`${textareaTestId}-expanded`}
                rows={14}
                spellCheck={spellCheck}
                maxLength={maxLength}
                placeholder={placeholder}
                value={draft}
                disabled={disabled}
                readOnly={readOnly}
                aria-label={label}
                aria-invalid={(draftError ?? error) ? true : undefined}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  // Native Escape reaches the dialog as `cancel`, which jsdom
                  // and some hosts never fire; handle it here too (idempotent).
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  if (expandedPickerOpen.current) {
                    // Let the picker close first; the dialog cancel guard holds.
                    event.stopPropagation();
                    return;
                  }
                  closeDiscard();
                }}
                onDrop={expandedField.inputProps.onDrop}
              />
              {mode === "none" ? null : expandedField.picker}
            </div>
            {draftError ? (
              <p className="inspector-error" role="alert">
                {draftError}
              </p>
            ) : error ? (
              <p className="inspector-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
