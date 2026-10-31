import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "../src/ui/useDelayedFlag.js";

describe("useDelayedFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays false until the condition has held for the full delay", () => {
    const { result } = renderHook(() => useDelayedFlag(true, 4_000));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("never turns true when the condition clears before the delay", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 4_000), {
      initialProps: { active: true },
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(false);
  });

  it("resets when the condition clears after it has already turned true", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 1_000), {
      initialProps: { active: true },
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
