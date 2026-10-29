import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Graph } from "@devchestra/schema";
import { PickerScopeContext, useVariableField, VARIABLE_PICKER_MIME } from "../src/editor/inspector/fields/VariablePicker.js";

const graph = {
  nodes: [
    { id: "start", type: "start", name: "Start", params: [{ name: "topic", type: "string", required: true }] },
    { id: "fetch", type: "agent", name: "Fetch", cli: "pi", prompt: "hi", output: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, permissions: { network: false, write: [] } },
    { id: "after", type: "agent", name: "After", cli: "pi", prompt: "hi", output: { type: "object", properties: { a: { type: "string" } } }, permissions: { network: false, write: [] } },
    { id: "side", type: "agent", name: "Side", cli: "pi", prompt: "hi", output: { type: "object", properties: { s: { type: "string" } } }, permissions: { network: false, write: [] } },
    { id: "end", type: "end", name: "End", status: "success", result: "after" },
  ],
  edges: [
    { id: "e1", from: "start", to: "fetch" },
    { id: "e2", from: "fetch", to: "after" },
    { id: "e3", from: "after", to: "end" },
  ],
} as unknown as Graph;

function Inner({ mode, nodeId, field, initial }: { mode: "template" | "expression"; nodeId: string; field: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const f = useVariableField({
    nodeId, field, mode, value,
    commit: (next) => setValue(next),
    testId: "vars",
  });
  return (
    <>
      <textarea data-testid="field" value={value} onChange={(e) => setValue(e.currentTarget.value)} {...f.inputProps} />
      {f.picker}
    </>
  );
}

function FieldHarness(props: { mode: "template" | "expression"; nodeId: string; field: string; initial: string }) {
  return (
    <PickerScopeContext.Provider value={{ parentGraph: graph }}>
      <Inner {...props} />
    </PickerScopeContext.Provider>
  );
}

function openPicker() {
  fireEvent.click(screen.getByTestId("vars"));
}

describe("variable picker insertion", () => {
  it("inserts template and expression references with exact text", () => {
    const { unmount } = render(<FieldHarness mode="template" nodeId="end" field="result" initial="say " />);
    openPicker();
    const item = screen.getByTitle("{{ fetch.title }}");
    fireEvent.click(item);
    expect((screen.getByTestId("field") as HTMLTextAreaElement).value).toBe("say {{ fetch.title }}");
    unmount();
    render(<FieldHarness mode="expression" nodeId="end" field="result" initial="say " />);
    openPicker();
    // caret was at end ("say ".length); insertion appends there.
    const exprItem = screen.getByTitle("fetch.title");
    fireEvent.click(exprItem);
    expect((screen.getByTestId("field") as HTMLTextAreaElement).value).toBe("say fetch.title");
  });

  it("replaces the selected range and restores caret after inserted text", async () => {
    render(<FieldHarness mode="expression" nodeId="end" field="result" initial="hello world" />);
    const area = screen.getByTestId("field") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(6, 11);
    // Picker remembers the live selection on open.
    openPicker();
    fireEvent.click(screen.getByTitle("fetch.title"));
    expect(area.value).toBe("hello fetch.title");
    await waitFor(() => expect(document.activeElement).toBe(area));
    expect(area.selectionStart).toBe("hello fetch.title".length);
  });

  it("shows disconnected nodes but blocks click, keyboard and drag", () => {
    render(<FieldHarness mode="template" nodeId="fetch" field="prompt" initial="" />);
    openPicker();
    const group = screen.getByText("side").closest(".variable-picker-group")!;
    const buttons = within(group as HTMLElement).getAllByRole("button");
    const inserts = buttons.filter((b) => b.classList.contains("variable-picker-item"));
    expect(inserts.length).toBeGreaterThan(0);
    for (const b of inserts) {
      expect(b.hasAttribute("disabled")).toBe(true);
      expect((b as HTMLButtonElement).draggable).toBe(false);
      fireEvent.click(b);
    }
    expect((screen.getByTestId("field") as HTMLTextAreaElement).value).toBe("");
    fireEvent.keyDown(inserts[0]!, { key: "Enter" });
    expect((screen.getByTestId("field") as HTMLTextAreaElement).value).toBe("");
    expect(within(group as HTMLElement).getAllByText("This output is not available here. Connect it as an upstream dependency.").length).toBeGreaterThan(0);
  });

  it("blocks descendant and self references", () => {
    render(<FieldHarness mode="expression" nodeId="fetch" field="prompt" initial="" />);
    openPicker();
    // after is downstream of fetch: discoverable, but referencing it would create a cycle.
    const afterGroup = screen.getByText("after").closest(".variable-picker-group")!;
    for (const b of within(afterGroup as HTMLElement).getAllByRole("button").filter((b) => b.classList.contains("variable-picker-item"))) {
      expect(b.hasAttribute("disabled")).toBe(true);
    }
    // self reference is never offered as insertable: fetch group shows unavailable.
    const fetchGroup = screen.getByText("fetch").closest(".variable-picker-group")!;
    const fetchWhole = within(fetchGroup as HTMLElement).getByText("whole output").closest("button")!;
    expect(fetchWhole.hasAttribute("disabled")).toBe(true);
  });

  it("inserts references where actually in scope", () => {
    render(<FieldHarness mode="template" nodeId="end" field="result" initial="" />);
    openPicker();
    expect(screen.getByTitle("{{ fetch.title }}")).toBeInTheDocument();
  });

  it("inserts at the drop position and ignores ordinary text drops", () => {
    render(<FieldHarness mode="expression" nodeId="end" field="result" initial="abcdef" />);
    const area = screen.getByTestId("field") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(6, 6);
    // jsdom lacks caretRangeFromPoint; exercise the caretPositionFromPoint branch.
    const doc = area.ownerDocument as unknown as { caretPositionFromPoint?: unknown };
    const original = doc.caretPositionFromPoint;
    doc.caretPositionFromPoint = () => ({ offset: 3 });
    try {
      fireEvent.drop(area, { dataTransfer: { types: [VARIABLE_PICKER_MIME], getData: (t: string) => (t === VARIABLE_PICKER_MIME ? "fetch.title" : "") } });
    } finally {
      doc.caretPositionFromPoint = original;
    }
    expect(area.value).toBe("abcfetch.titledef");
    const before = area.value;
    fireEvent.drop(area, { dataTransfer: { types: ["text/plain"], getData: () => "hello" } });
    expect(area.value).toBe(before);
  });

  it("closes on Escape and outside click", () => {
    render(<FieldHarness mode="template" nodeId="end" field="result" initial="" />);
    openPicker();
    expect(screen.getByPlaceholderText("Search variables…")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Search variables…"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("Search variables…")).toBeNull();
    openPicker();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByPlaceholderText("Search variables…")).toBeNull();
  });

  it("allows expression insertion for template-unsafe keys", () => {
    const hazardous = {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        { id: "w", type: "agent", name: "W", cli: "pi", prompt: "hi", output: { type: "object", properties: { "x}}y": { type: "string" } } }, permissions: { network: false, write: [] } },
        { id: "end", type: "end", name: "End", status: "success", result: "w" },
      ],
      edges: [
        { id: "e1", from: "start", to: "w" },
        { id: "e2", from: "w", to: "end" },
      ],
    } as unknown as Graph;
    const commits: string[] = [];
    render(
      <PickerScopeContext.Provider value={{ parentGraph: hazardous }}>
        <Probe mode="expression" onCommit={(s) => commits.push(s)} />
      </PickerScopeContext.Provider>,
    );
    fireEvent.click(screen.getByTestId("vars"));
    const item = screen.getByTitle('w."x}}y"');
    expect(item.closest("button")!.disabled).toBe(false);
    fireEvent.click(item);
    expect(commits[0]).toBe('w."x}}y"');
  });
});

function ProbeInner({ mode, onCommit }: { mode: "template" | "expression"; onCommit: (s: string) => void }) {
  const f = useVariableField({ nodeId: "end", field: "result", mode, value: "", commit: onCommit, testId: "vars" });
  return (
    <>
      <textarea data-testid="probe-field" value="" onChange={() => {}} {...f.inputProps} />
      {f.picker}
    </>
  );
}

function Probe(props: { mode: "template" | "expression"; onCommit: (s: string) => void }) {
  return <ProbeInner {...props} />;
}
