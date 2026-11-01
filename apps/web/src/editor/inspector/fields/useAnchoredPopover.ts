import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";

export interface AnchoredPlacement {
  position: "fixed";
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export interface PlaceAnchoredOptions {
  /** Preferred width; the popover is at least as wide as the anchor. */
  minWidth: number;
  maxHeight: number;
  /** Measured popover height, when known, so the flip decision uses the real size. */
  height?: number | undefined;
  /** Which anchor edge the popover lines up with. */
  align?: "start" | "end";
  margin?: number;
  gap?: number;
}

/** Line up with the anchor, flip above when short of room below, clamp to the viewport. */
export function placeAnchored(
  anchor: DOMRect,
  vw: number,
  vh: number,
  options: PlaceAnchoredOptions,
): AnchoredPlacement {
  const margin = options.margin ?? 8;
  const gap = options.gap ?? 6;
  const align = options.align ?? "start";
  const width = Math.max(0, Math.min(Math.max(options.minWidth, anchor.width), vw - margin * 2));
  const wantedLeft = align === "start" ? anchor.left : anchor.right - width;
  const left = Math.max(margin, Math.min(wantedLeft, vw - width - margin));
  const below = vh - anchor.bottom - margin * 2;
  const above = anchor.top - margin * 2;
  const h = Math.min(options.height ?? options.maxHeight, options.maxHeight);
  const flip = below < h && above > below;
  const maxHeight = Math.max(120, Math.min(options.maxHeight, flip ? above : below));
  const top = flip
    ? Math.max(margin, anchor.top - gap - Math.min(h, maxHeight))
    : Math.min(anchor.bottom + gap, Math.max(margin, vh - margin - Math.min(h, maxHeight)));
  return { position: "fixed", left, top, width, maxHeight };
}

export interface UseAnchoredPopoverOptions extends Omit<PlaceAnchoredOptions, "height"> {
  open: boolean;
  /** Called on outside press and on Escape. */
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  popRef: RefObject<HTMLElement | null>;
}

/**
 * Positioning and dismissal for a portaled popover anchored to a trigger.
 *
 * - Follows scroll (capture, so inner scrollers count) and resize while open.
 * - An outside mousedown closes; presses on the anchor or inside the popover do not.
 * - Escape closes from any focus (capture, stopped) and returns focus to the anchor.
 *
 * Render the popover with `style={style}`; it stays `visibility: hidden` until measured.
 */
export function useAnchoredPopover({
  open,
  onClose,
  anchorRef,
  popRef,
  ...place
}: UseAnchoredPopoverOptions): { style: CSSProperties } {
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);
  const { minWidth, maxHeight, align, margin, gap } = place;

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const view = anchor.ownerDocument.defaultView;
    setPlacement(
      placeAnchored(
        anchor.getBoundingClientRect(),
        view?.innerWidth ?? 1024,
        view?.innerHeight ?? 768,
        {
          minWidth,
          maxHeight,
          height: popRef.current?.offsetHeight,
          ...(align === undefined ? {} : { align }),
          ...(margin === undefined ? {} : { margin }),
          ...(gap === undefined ? {} : { gap }),
        },
      ),
    );
  }, [anchorRef, popRef, minWidth, maxHeight, align, margin, gap]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    reposition();
    const view = anchorRef.current?.ownerDocument.defaultView;
    view?.addEventListener("resize", reposition);
    view?.addEventListener("scroll", reposition, true);
    return () => {
      view?.removeEventListener("resize", reposition);
      view?.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const doc = anchorRef.current?.ownerDocument ?? document;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    doc.addEventListener("mousedown", onDown);
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("mousedown", onDown);
      doc.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchorRef, popRef]);

  return { style: placement ?? { visibility: "hidden" } };
}
