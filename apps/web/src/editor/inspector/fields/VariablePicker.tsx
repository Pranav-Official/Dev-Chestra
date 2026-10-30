import type { Graph } from "@devchestra/schema";
import {
  type CatalogRequest,
  catalogForField,
  isInsertableForMode,
  type NodeCatalog,
} from "@devchestra/schema";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface PickerScope {
  /** Outer workflow graph (owns the enclosing loop for body fields). */
  parentGraph?: Graph | undefined;
  /** Local body draft for body fields. */
  draft?: Graph | undefined;
  /** Enclosing loop id for body fields and controller namespaces. */
  loopId?: string | undefined;
  /** Enclosing sequential collection controller. */
  foreachId?: string | undefined;
  /** Local body node id for body fields. */
  localNodeId?: string | undefined;
}

export const PickerScopeContext = createContext<PickerScope>({});

export function usePickerScope(explicit?: PickerScope): PickerScope {
  const ctx = useContext(PickerScopeContext);
  return {
    parentGraph: explicit?.parentGraph ?? ctx.parentGraph,
    draft: explicit?.draft ?? ctx.draft,
    loopId: explicit?.loopId ?? ctx.loopId,
    foreachId: explicit?.foreachId ?? ctx.foreachId,
    localNodeId: explicit?.localNodeId ?? ctx.localNodeId,
  };
}

/** Back-compat: a bare graph is the parent graph (top-level fields). */
export function useCatalog(scope: PickerScope, nodeId: string, field: string): NodeCatalog[] {
  return useMemo(() => {
    const parentGraph = scope.parentGraph;
    if (!parentGraph) return [];
    const req: CatalogRequest =
      scope.draft && (scope.loopId || scope.foreachId)
        ? {
            parentGraph,
            draft: scope.draft,
            ...(scope.foreachId ? { foreachId: scope.foreachId } : { loopId: scope.loopId }),
            nodeId: scope.localNodeId ?? nodeId,
            field,
          }
        : {
            parentGraph,
            nodeId,
            field,
            ...(parentGraph.nodes.some((n) => n.id === nodeId && n.type === "loop")
              ? { loopId: nodeId }
              : parentGraph.nodes.some((n) => n.id === nodeId && n.type === "foreach")
                ? { foreachId: nodeId }
                : {}),
          };
    try {
      return catalogForField(req);
    } catch {
      return [];
    }
  }, [
    scope.parentGraph,
    scope.draft,
    scope.loopId,
    scope.foreachId,
    scope.localNodeId,
    nodeId,
    field,
  ]);
}

export const VARIABLE_PICKER_MIME = "application/x-devchestra-variable";

export interface VariableField {
  /** Current field text (buffered value when buffered). */
  value: string;
  /** Commit a full next value through the existing change handler. */
  commit: (next: string) => void;
  /** Ref of the editable element for caret/focus/drop handling. */
  ref: React.RefObject<HTMLTextAreaElement | null>;
  /** Props to spread on the textarea/input: drop + caret tracking. */
  inputProps: {
    ref: React.RefObject<HTMLTextAreaElement | null>;
    onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => void;
  };
  /** Rendered picker element for this field. */
  picker: React.ReactNode;
}

/**
 * Shared field wiring: one caret tracker, one insertion path for click,
 * keyboard and drag, drop at the actual pointer position with selection
 * replacement and caret/focus restore, ordinary text drops untouched.
 */
export function useVariableField(args: {
  nodeId: string;
  field: string;
  mode: "template" | "expression";
  value: string;
  commit: (next: string) => void;
  testId: string;
  onOpenChange?: (open: boolean) => void;
}): VariableField {
  const ref = useRef<HTMLTextAreaElement>(null);
  const scope = usePickerScope();
  const caret = useRef<{ start: number; end: number } | null>(null);

  const insertText = (text: string, at?: { start: number; end: number }) => {
    const el = ref.current;
    const base = el?.value ?? args.value;
    // Live selection is trusted only while the field is focused; otherwise the
    // remembered caret (captured on picker-button mousedown) or the end wins.
    const live =
      el && el.ownerDocument.activeElement === el
        ? { start: el.selectionStart ?? base.length, end: el.selectionEnd ?? base.length }
        : null;
    const start = at?.start ?? caret.current?.start ?? live?.start ?? base.length;
    const end = at?.end ?? caret.current?.end ?? live?.end ?? base.length;
    const next = base.slice(0, start) + text + base.slice(end);
    args.commit(next);
    caret.current = { start: start + text.length, end: start + text.length };
    requestAnimationFrame(() => {
      const nextEl = ref.current;
      const pos = caret.current;
      if (!nextEl || !pos) return;
      nextEl.focus();
      try {
        nextEl.setSelectionRange(pos.start, pos.end);
      } catch {
        // inputs without selection support
      }
    });
  };

  const onDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!event.dataTransfer.types.includes(VARIABLE_PICKER_MIME)) return;
    const text = event.dataTransfer.getData(VARIABLE_PICKER_MIME);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    // Actual drop position where supported; selection replaces the range.
    let start = target.selectionStart ?? args.value.length;
    let end = target.selectionEnd ?? args.value.length;
    try {
      const doc = target.ownerDocument;
      const rangeTarget = (
        doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint?.(event.clientX, event.clientY);
      const posTarget = (
        doc as Document & {
          caretPositionFromPoint?: (x: number, y: number) => { offset: number } | null;
        }
      ).caretPositionFromPoint?.(event.clientX, event.clientY);
      if (rangeTarget && target.contains(rangeTarget.startContainer)) {
        const preRange = rangeTarget.cloneRange();
        preRange.selectNodeContents(target);
        preRange.setEnd(rangeTarget.startContainer, rangeTarget.startOffset);
        start = end = preRange.toString().length;
      } else if (posTarget && target.contains(target)) {
        start = end = Math.min(posTarget.offset, (target.value ?? "").length);
      }
    } catch {
      // Fall back to the live caret/selection below.
    }
    insertText(text, { start, end });
  };

  const rememberCaret = () => {
    const el = ref.current;
    if (!el) return;
    // Record only while the field is focused; otherwise a never-touched
    // field would pin a bogus {0,0} caret instead of appending at the end.
    if (el.ownerDocument.activeElement !== el) return;
    caret.current = {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    };
  };

  const picker = (
    <VariablePicker
      scope={scope}
      nodeId={args.nodeId}
      field={args.field}
      mode={args.mode}
      onInsert={insertText}
      onRememberCaret={rememberCaret}
      testId={args.testId}
      {...(args.onOpenChange === undefined ? {} : { onOpenChange: args.onOpenChange })}
    />
  );
  return { value: args.value, commit: args.commit, ref, inputProps: { ref, onDrop }, picker };
}

export interface PopoverPlacement {
  position: "fixed";
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const POP_WIDTH = 320;
const POP_MAX_HEIGHT = 320;
const POP_MARGIN = 8;

/** Right-align under the anchor, flip above when short of room, clamp to the viewport. */
export function placePopover(
  anchor: DOMRect,
  vw: number,
  vh: number,
  height = POP_MAX_HEIGHT,
): PopoverPlacement {
  const width = Math.max(0, Math.min(POP_WIDTH, vw - POP_MARGIN * 2));
  const left = Math.max(POP_MARGIN, Math.min(anchor.right - width, vw - width - POP_MARGIN));
  const below = vh - anchor.bottom - POP_MARGIN * 2;
  const above = anchor.top - POP_MARGIN * 2;
  const h = Math.min(height, POP_MAX_HEIGHT);
  const flip = below < h && above > below;
  const maxHeight = Math.max(120, Math.min(POP_MAX_HEIGHT, flip ? above : below));
  const top = flip
    ? Math.max(POP_MARGIN, anchor.top - 6 - Math.min(h, maxHeight))
    : Math.min(anchor.bottom + 6, Math.max(POP_MARGIN, vh - POP_MARGIN - Math.min(h, maxHeight)));
  return { position: "fixed", left, top, width, maxHeight };
}

/**
 * Minimal variable picker: a subtle `{}` button opening a compact searchable
 * popover. Groups properties under node names, shows type + availability,
 * offers whole-output insertion. Click/keyboard/drag share one centralized
 * eligibility rule; unavailable and needs-dependency entries stay visible
 * with explanations but are never insertable.
 */
export function VariablePicker({
  scope,
  nodeId,
  field,
  mode,
  onInsert,
  onRememberCaret,
  testId,
  onOpenChange,
}: {
  scope: PickerScope;
  nodeId: string;
  field: string;
  mode: "template" | "expression";
  onInsert: (text: string) => void;
  onRememberCaret: () => void;
  testId: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const catalog = useCatalog(scope, nodeId, field);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const reposition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const view = button.ownerDocument.defaultView;
    setPlacement(
      placePopover(
        button.getBoundingClientRect(),
        view?.innerWidth ?? 1024,
        view?.innerHeight ?? 768,
        popRef.current?.offsetHeight,
      ),
    );
  }, []);

  // Anchored to the button, clamped to the viewport; follows scroll/resize.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    reposition();
    const view = buttonRef.current?.ownerDocument.defaultView;
    view?.addEventListener("resize", reposition);
    view?.addEventListener("scroll", reposition, true);
    return () => {
      view?.removeEventListener("resize", reposition);
      view?.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  // Outside press and Escape (from any focus, including inside a modal
  // dialog, whose native Esc must not also close the dialog) dismiss.
  useEffect(() => {
    if (!open) return;
    const doc = buttonRef.current?.ownerDocument ?? document;
    const onDown = (event: MouseEvent) => {
      if (popRef.current?.contains(event.target as Node)) return;
      if (buttonRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    doc.addEventListener("mousedown", onDown);
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("mousedown", onDown);
      doc.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog
      .map((node) => {
        const matchesNode =
          node.nodeName.toLowerCase().includes(q) || node.nodeId.toLowerCase().includes(q);
        const props = node.properties.filter(
          (p) =>
            p.path.join(".").toLowerCase().includes(q) ||
            p.typeLabel.toLowerCase().includes(q) ||
            matchesNode,
        );
        const wholeMatches =
          matchesNode ||
          node.wholeRef.typeLabel.toLowerCase().includes(q) ||
          "whole output".includes(q);
        if (!matchesNode && props.length === 0 && !wholeMatches) return null;
        return { ...node, properties: matchesNode && props.length === 0 ? node.properties : props };
      })
      .filter((n): n is NodeCatalog => n !== null);
  }, [catalog, query]);

  const insertAndClose = (text: string) => {
    onInsert(text);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <span className="variable-picker">
      <button
        ref={buttonRef}
        type="button"
        className="variable-picker-btn"
        data-testid={testId}
        aria-label="Insert variable"
        title="Insert variable"
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseDown={(e) => {
          onRememberCaret();
          e.preventDefault();
        }}
        onClick={() => {
          onRememberCaret();
          setOpen((v) => !v);
          requestAnimationFrame(() => searchRef.current?.focus());
        }}
        onFocus={onRememberCaret}
      >
        {"{}"}
      </button>
      {open
        ? createPortal(
            <span
              ref={popRef}
              className="variable-picker-pop"
              role="dialog"
              aria-label="Variables"
              data-testid={`${testId}-popover`}
              style={placement ?? { visibility: "hidden" }}
            >
              <input
                ref={searchRef}
                className="inspector-input variable-picker-search"
                placeholder="Search variables…"
                value={query}
                aria-label="Search variables"
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              <span className="variable-picker-list">
                {filtered.length === 0 ? (
                  <span className="variable-picker-empty">No variables match.</span>
                ) : (
                  filtered.map((node) => {
                    const isOpen = expanded[node.nodeId] ?? true;
                    const wholeText =
                      mode === "template" ? node.wholeRef.templateRef : node.wholeRef.expressionRef;
                    const wholeInsertable = isInsertableForMode(node.wholeRef, mode);
                    return (
                      <span key={node.nodeId} className="variable-picker-group">
                        <button
                          type="button"
                          className="variable-picker-node"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded((p) => ({ ...p, [node.nodeId]: !isOpen }))}
                        >
                          <span className="variable-picker-node-name">{node.nodeName}</span>
                          <span className="variable-picker-node-id mono">{node.nodeId}</span>
                          <span className={`variable-picker-avail ${node.wholeRef.availability}`}>
                            {node.wholeRef.availability}
                          </span>
                        </button>
                        {isOpen ? (
                          <span className="variable-picker-items">
                            <span className="variable-picker-item-row">
                              <button
                                type="button"
                                className="variable-picker-item"
                                disabled={!wholeInsertable}
                                title={
                                  node.wholeRef.reason ??
                                  (wholeInsertable ? wholeText : "Not insertable here.")
                                }
                                draggable={wholeInsertable}
                                onDragStart={(e) => {
                                  if (!wholeInsertable) return;
                                  e.dataTransfer.setData(VARIABLE_PICKER_MIME, wholeText);
                                  e.dataTransfer.effectAllowed = "copy";
                                }}
                                onClick={() => {
                                  if (wholeInsertable) insertAndClose(wholeText);
                                }}
                                onKeyDown={(e) => {
                                  if ((e.key === "Enter" || e.key === " ") && wholeInsertable) {
                                    e.preventDefault();
                                    insertAndClose(wholeText);
                                  }
                                }}
                              >
                                <span className="mono">whole output</span>
                                <span className="variable-picker-type">
                                  {node.wholeRef.typeLabel}
                                </span>
                              </button>
                              {!wholeInsertable && node.wholeRef.reason ? (
                                <span className="variable-picker-reason">
                                  {node.wholeRef.reason}
                                </span>
                              ) : null}
                            </span>
                            {node.properties.map((prop) => {
                              const text =
                                mode === "template" ? prop.templateRef : prop.expressionRef;
                              const canInsert = isInsertableForMode(prop, mode);
                              const label = prop.path.join(".");
                              const blocked =
                                !canInsert &&
                                (prop.availability === "unavailable" ||
                                  prop.availability === "needs-dependency");
                              return (
                                <span
                                  key={prop.jsonPointer || "(whole)"}
                                  className="variable-picker-item-row"
                                >
                                  <button
                                    type="button"
                                    className="variable-picker-item"
                                    disabled={!canInsert}
                                    title={
                                      prop.reason ?? (canInsert ? text : "Not insertable here.")
                                    }
                                    draggable={canInsert}
                                    onDragStart={(e) => {
                                      if (!canInsert) return;
                                      e.dataTransfer.setData(VARIABLE_PICKER_MIME, text);
                                      e.dataTransfer.effectAllowed = "copy";
                                    }}
                                    onClick={() => {
                                      if (canInsert) insertAndClose(text);
                                    }}
                                    onKeyDown={(e) => {
                                      if ((e.key === "Enter" || e.key === " ") && canInsert) {
                                        e.preventDefault();
                                        insertAndClose(text);
                                      }
                                    }}
                                  >
                                    <span className="mono">{label}</span>
                                    <span className="variable-picker-type">{prop.typeLabel}</span>
                                    <span className={`variable-picker-avail ${prop.availability}`}>
                                      {prop.availability}
                                    </span>
                                  </button>
                                  {blocked ? (
                                    <span className="variable-picker-reason">
                                      {prop.reason ??
                                        "This output is not available here. Connect it as an upstream dependency."}
                                    </span>
                                  ) : null}
                                  {!canInsert && !blocked && prop.reason ? (
                                    <span className="variable-picker-reason">{prop.reason}</span>
                                  ) : null}
                                </span>
                              );
                            })}
                          </span>
                        ) : null}
                      </span>
                    );
                  })
                )}
              </span>
              <span className="variable-picker-hint">
                Unavailable properties are shown with an explanation and cannot be inserted.
              </span>
            </span>,
            // Inside the enclosing modal <dialog> (top layer) when there is one,
            // otherwise body: escapes inspector clipping and canvas stacking.
            buttonRef.current?.closest("dialog") ??
              buttonRef.current?.ownerDocument.body ??
              document.body,
          )
        : null}
    </span>
  );
}
