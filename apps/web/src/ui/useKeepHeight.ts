import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps a box from shrinking below the tallest height it has shown while it is
 * mounted. Collapsing content inside the box then changes what is inside it,
 * not the box itself, so the surrounding panel does not jump. Growing still
 * works: the box follows content that gets taller.
 */
export function useKeepHeight<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  style: CSSProperties | undefined;
} {
  const ref = useRef<T | null>(null);
  const [minHeight, setMinHeight] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const height = element.offsetHeight;
      setMinHeight((current) => (height > current ? height : current));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, style: minHeight > 0 ? { minHeight } : undefined };
}
