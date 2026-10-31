import { useEffect, useState } from "react";

/**
 * True once `active` has stayed true for `delayMs`. Resets as soon as `active`
 * turns false, so a settled request never keeps a stale "taking long" state.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}
