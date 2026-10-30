import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Graph } from "@devchestra/schema";
import { PickerScopeContext, placePopover, useVariableField } from "../src/editor/inspector/fields/VariablePicker.js";

const graph = {
  nodes: [
    { id: "start", type: "start", name: "Start", params: [{ name: "topic", type: "string", required: true }] },
    { id: "end", type: "end", name: "End", status: "success", result: "start" },
  ],
  edges: [{ id: "e1", from: "start", to: "end" }],
} as unknown as Graph;

function Field() {
  const [value, setValue] = useState("abc");
  const f = useVariableField({ nodeId: "end", field: "result", mode: "template", value, commit: setValue, testId: "vars" });
  return (
    <div data-testid="inspector" style={{ overflow: "hidden" }}>
      <textarea data-testid="field" value={value} onChange={(e) => setValue(e.currentTarget.value)} {...f.inputProps} />
      {f.picker}
    </div>
  );
}

const harness = (
  <PickerScopeContext.Provider value={{ parentGraph: graph }}>
    <Field />
  </PickerScopeContext.Provider>
);

const rect = (r: Partial<DOMRect>) => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...r }) as DOMRect;

describe("variable picker popover placement", () => {
  it("clamps to the viewport instead of overflowing left of a narrow anchor", () => {
    const p = placePopover(rect({ left: 40, right: 60, top: 100, bottom: 120 }), 400, 600);
    expect(p.position).toBe("fixed");
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(400 - 8);
    expect(p.top).toBe(126);
  });

  it("shrinks on tiny viewports and flips above near the bottom", () => {
    const small = placePopover(rect({ right: 300, top: 10, bottom: 30 }), 200, 600);
    expect(small.width).toBe(184);
    expect(small.left).toBe(8);
    const flipped = placePopover(rect({ right: 600, top: 560, bottom: 580 }), 800, 600);
    expect(flipped.top + Math.min(320, flipped.maxHeight)).toBeLessThanOrEqual(560);
    expect(flipped.top).toBeGreaterThanOrEqual(8);
  });
});

describe("variable picker popover layer", () => {
  it("renders outside the clipping inspector, in body, fixed", () => {
    render(harness);
    fireEvent.click(screen.getByTestId("vars"));
    const pop = screen.getByTestId("vars-popover");
    expect(screen.getByTestId("inspector").contains(pop)).toBe(false);
    expect(pop.parentElement).toBe(document.body);
    expect(pop.style.position).toBe("fixed");
  });

  it("renders inside the enclosing modal dialog so it stays above it", () => {
    render(<dialog open data-testid="dlg">{harness}</dialog>);
    fireEvent.click(screen.getByTestId("vars"));
    expect(screen.getByTestId("dlg").contains(screen.getByTestId("vars-popover"))).toBe(true);
  });

  it("closes on Escape from the textarea, search and list without leaking to the dialog", () => {
    let leaked = false;
    render(
      <div onKeyDown={() => { leaked = true; }}>
        <dialog open>{harness}</dialog>
      </div>,
    );
    for (const target of [() => screen.getByTestId("field"), () => screen.getByPlaceholderText("Search variables…"), () => screen.getAllByRole("button", { name: /start/i })[0]!]) {
      fireEvent.click(screen.getByTestId("vars"));
      expect(screen.queryByTestId("vars-popover")).not.toBeNull();
      fireEvent.keyDown(target(), { key: "Escape" });
      expect(screen.queryByTestId("vars-popover")).toBeNull();
    }
    expect(leaked).toBe(false);
  });

  it("closes on outside mousedown but not inside, and keeps typing/search working", () => {
    render(harness);
    fireEvent.click(screen.getByTestId("vars"));
    const search = screen.getByPlaceholderText("Search variables…") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(search.value).toBe("zzz");
    expect(screen.getByText("No variables match.")).toBeInTheDocument();
    fireEvent.mouseDown(search);
    expect(screen.queryByTestId("vars-popover")).not.toBeNull();
    fireEvent.keyDown(search, { key: "a" });
    expect(screen.queryByTestId("vars-popover")).not.toBeNull();
    fireEvent.mouseDown(screen.getByTestId("field"));
    expect(screen.queryByTestId("vars-popover")).toBeNull();
  });

  it("repositions on resize/scroll without throwing and cleans up on close", () => {
    render(harness);
    fireEvent.click(screen.getByTestId("vars"));
    fireEvent(window, new Event("resize"));
    fireEvent.scroll(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("vars-popover")).toBeNull();
    fireEvent(window, new Event("resize"));
  });
});

describe("loop detail layout styles", () => {
  it("stacks sections in a column and bounds JSON overflow", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/run.css"), "utf8");
    expect(css).toMatch(/\.note\.loop-detail\s*{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.loop-detail pre\.code\s*{[^}]*overflow:\s*auto/);
  });
});
