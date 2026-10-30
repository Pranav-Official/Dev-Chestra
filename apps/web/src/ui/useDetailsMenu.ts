import type { FocusEvent, KeyboardEvent } from "react";
import { useRef } from "react";

/**
 * Popover behaviour for a `<details className="workspace-menu">`: Escape returns
 * focus to the summary, and focus leaving the menu closes it.
 */
export function useDetailsMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  return {
    ref,
    close() {
      if (ref.current) ref.current.open = false;
    },
    onKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
      if (event.key !== "Escape") return;
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    },
    onBlur(event: FocusEvent<HTMLDetailsElement>) {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      event.currentTarget.open = false;
    },
  };
}
