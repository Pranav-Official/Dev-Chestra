import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  placeAnchored,
  useAnchoredPopover,
} from "../src/editor/inspector/fields/useAnchoredPopover.js";

function rect(partial: Partial<DOMRect>): DOMRect {
  const base = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  return { ...base, ...partial, toJSON: () => ({}) } as DOMRect;
}

describe("placeAnchored", () => {
  const opts = { minWidth: 340, maxHeight: 420 };

  it("opens below, left-aligned, at least minWidth wide", () => {
    const p = placeAnchored(
      rect({ left: 20, right: 220, top: 100, bottom: 130, width: 200 }),
      1000,
      800,
      opts,
    );
    expect(p.left).toBe(20);
    expect(p.width).toBe(340);
    expect(p.top).toBe(136);
  });

  it("is as wide as a wider anchor", () => {
    const p = placeAnchored(
      rect({ left: 20, right: 520, top: 100, bottom: 130, width: 500 }),
      1000,
      800,
      opts,
    );
    expect(p.width).toBe(500);
  });

  it("flips above when there is no room below", () => {
    const p = placeAnchored(
      rect({ left: 20, right: 220, top: 700, bottom: 730, width: 200 }),
      1000,
      760,
      opts,
    );
    expect(p.top).toBeLessThan(700);
  });

  it("clamps to the viewport horizontally", () => {
    const p = placeAnchored(
      rect({ left: 900, right: 980, top: 10, bottom: 40, width: 80 }),
      1000,
      800,
      opts,
    );
    expect(p.left + p.width).toBeLessThanOrEqual(1000 - 8);
  });

  it("never exceeds a narrow viewport", () => {
    const p = placeAnchored(
      rect({ left: 0, right: 100, top: 10, bottom: 40, width: 100 }),
      300,
      800,
      opts,
    );
    expect(p.width).toBe(284);
  });
});

function Harness({ onClose }: { onClose: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { style } = useAnchoredPopover({
    open: true,
    onClose,
    anchorRef,
    popRef,
    minWidth: 300,
    maxHeight: 300,
  });
  return (
    <div>
      <button type="button" ref={anchorRef}>
        anchor
      </button>
      <div ref={popRef} data-testid="pop" style={style}>
        <button type="button">inside</button>
      </div>
      <button type="button">outside</button>
    </div>
  );
}

describe("useAnchoredPopover", () => {
  it("positions the popover as fixed", () => {
    render(<Harness onClose={() => undefined} />);
    expect(screen.getByTestId("pop").style.position).toBe("fixed");
  });

  it("closes on outside press but not on anchor or inside presses", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("anchor"));
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and returns focus to the anchor", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    screen.getByText("inside").focus();
    fireEvent.keyDown(screen.getByText("inside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByText("anchor"));
  });
});
