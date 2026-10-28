import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  // jsdom has no DOMMatrixReadOnly; React Flow reads a node's CSS transform scale with it
  // when it measures handles.
  if (window.DOMMatrixReadOnly === undefined) {
    window.DOMMatrixReadOnly = class {
      m22 = 1;
      constructor(transform?: string) {
        const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
        if (scale !== undefined) this.m22 = Number(scale);
      }
    } as unknown as typeof DOMMatrixReadOnly;
  }
  if (window.matchMedia === undefined) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (globalThis.ResizeObserver === undefined) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
}

afterEach(() => cleanup());
