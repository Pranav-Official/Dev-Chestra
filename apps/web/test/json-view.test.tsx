import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonTree } from "../src/ui/JsonTree.js";
import { JsonView } from "../src/ui/JsonView.js";

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOffsetHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
  }
});

const small = { ok: true, count: 2, tags: ["a", "b"] };
const large = {
  feedback: "PASS. ".repeat(60),
  evidence: Array.from({ length: 8 }, (_, index) => `evidence line ${index}`),
};

describe("JsonView", () => {
  it("renders a short value inline with no expand control", () => {
    render(<JsonView value={small} testId="json" label="Output" />);
    expect(screen.getByTestId("json")).toHaveClass("json-inline");
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(screen.getByText('"tags"')).toBeInTheDocument();
  });

  it("previews a large value and opens the full structure in a dialog", () => {
    render(<JsonView value={large} testId="json" label="Output" />);
    expect(screen.getByTestId("json")).toHaveClass("json-preview");

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog", { name: "Output" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('"evidence"')).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
    // One scroller only: the frame holds the size, the JSON section scrolls.
    expect(dialog.querySelector(".editor-dialog-body")).toHaveClass("json-dialog-frame");
    expect(within(dialog).getByLabelText("Output")).toHaveClass("json-dialog-body");
  });

  it("removes the dialog from the page when it closes", () => {
    render(<JsonView value={large} testId="json" label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the full structure several levels deep, not only the top", () => {
    const nested = { note: "x".repeat(400), a: { b: { c: { d: "deep value" } } } };
    render(<JsonView value={nested} testId="json" label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog", { name: "Output" });
    expect(within(dialog).getByText('"d"')).toBeInTheDocument();
    expect(within(dialog).queryByTestId("json-large-notice")).toBeNull();
  });

  it("warns on a large value and starts its nested items collapsed", () => {
    const groups = Array.from({ length: 1000 }, (_, index) => ({
      name: `group ${index}`,
      items: [1, 2],
    }));
    render(<JsonView value={{ groups }} testId="json" label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog", { name: "Output" });
    expect(within(dialog).getByTestId("json-large-notice")).toBeInTheDocument();
    expect(within(dialog).getByText('"groups"')).toBeInTheDocument();
    // The entries are not mounted until the reader expands "groups".
    expect(within(dialog).queryByText('"name"')).toBeNull();
  });

  it("mounts a wide flat payload 200 entries at a time, not all at once", () => {
    const flat = Array.from({ length: 6000 }, (_, index) => index);
    render(<JsonView value={flat} testId="json" label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog", { name: "Output" });
    expect(within(dialog).getByTestId("json-large-notice")).toBeInTheDocument();
    expect(dialog.querySelectorAll(".json-num")).toHaveLength(200);

    fireEvent.click(within(dialog).getByTestId("json-show-more"));
    expect(dialog.querySelectorAll(".json-num")).toHaveLength(400);
    expect(within(dialog).getByTestId("json-show-more")).toHaveTextContent("200 more (5600 left)");
  });

  it("opens a payload nested far past the stack limit without throwing", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 1500; index += 1) deep = { child: deep };
    render(<JsonView value={deep} testId="json" label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog", { name: "Output" });
    expect(within(dialog).queryByText(/nested deeper than/)).toBeNull();
    expect(dialog.querySelector("pre.code")).toBeNull();
  });

  it("shows the raw text instead of blanking when a value cannot be rendered", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = {
      get boom(): never {
        throw new Error("getter failed");
      },
    };
    const { container } = render(<JsonView value={hostile} testId="json" />);
    expect(container.querySelector("pre.code")).not.toBeNull();
    spy.mockRestore();
  });

  it("shows nothing for a null value", () => {
    render(<JsonView value={null} testId="json" />);
    expect(screen.getByTestId("json")).toBeEmptyDOMElement();
  });
});

describe("JsonTree", () => {
  it("renders multi-line strings as text blocks, not escaped lines", () => {
    const { container } = render(<JsonTree value={{ feedback: "First line.\n\nSecond line." }} />);
    const block = container.querySelector(".json-block");
    expect(block).not.toBeNull();
    expect(block).toHaveTextContent("First line.");
    expect(block).toHaveTextContent("Second line.");
    expect(container.textContent).not.toContain("\\n");
  });

  it("collapses and expands a container", () => {
    render(<JsonTree value={{ items: [1, 2, 3] }} />);
    const toggle = screen.getByRole("button", { name: "Collapse items" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Expand items" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("stops at the nesting limit instead of overflowing the stack", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 1500; index += 1) deep = { child: deep };
    render(<JsonTree value={deep} openDepth={Number.POSITIVE_INFINITY} />);
    expect(screen.getByText(/nested deeper than 64 levels/)).toBeInTheDocument();
  });

  it("colours keys, numbers, booleans and nulls by kind", () => {
    const { container } = render(<JsonTree value={{ n: 4, b: true, z: null }} />);
    expect(container.querySelector(".json-key")).toHaveTextContent('"n"');
    expect(container.querySelector(".json-num")).toHaveTextContent("4");
    expect(container.querySelector(".json-bool")).toHaveTextContent("true");
    expect(container.querySelector(".json-null")).toHaveTextContent("null");
  });
});

describe("keeps its height when content collapses", () => {
  it("does not shrink below the tallest height it has shown, and grows with taller content", () => {
    let height = 200;
    let notify: () => void = () => undefined;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => height,
    });
    class FakeResizeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    render(<JsonView value={small} testId="json" />);
    const box = screen.getByTestId("json");
    expect(box.style.minHeight).toBe("200px");

    height = 40;
    act(() => notify());
    expect(box.style.minHeight).toBe("200px");

    height = 260;
    act(() => notify());
    expect(box.style.minHeight).toBe("260px");
  });
});

describe("ErrorBoundary", () => {
  it("replaces only the failing subtree with its fallback", async () => {
    const { ErrorBoundary } = await import("../src/ui/ErrorBoundary.js");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error("render failed");
    }
    render(
      <div>
        <span>outside</span>
        <ErrorBoundary fallback={<span>fallback</span>}>
          <Broken />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("fallback")).toBeInTheDocument();
    expect(screen.getByText("outside")).toBeInTheDocument();
    spy.mockRestore();
  });
});
