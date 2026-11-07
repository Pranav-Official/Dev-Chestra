import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/editor/controls/Dialog.js";

describe("nested dialog events", () => {
  it.each(["close", "cancel"])("keeps a child %s event inside its dialog", (type) => {
    const outerClose = vi.fn();
    const outerGuard = vi.fn(() => false);
    const innerClose = vi.fn();
    render(
      <Dialog open title="Outer" onClose={outerClose} cancelGuard={outerGuard}>
        <Dialog open title="Inner" onClose={innerClose} testId="inner-dialog">
          Child content
        </Dialog>
      </Dialog>,
    );
    // Native close/cancel do not bubble, but React dispatches them through ancestors.
    fireEvent(
      screen.getByTestId("inner-dialog"),
      new Event(type, { bubbles: false, cancelable: type === "cancel" }),
    );
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
    expect(outerGuard).not.toHaveBeenCalled();
  });

  it.each(["close", "cancel"])("still handles its own %s event", (type) => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Dialog" onClose={onClose} testId="dialog">
        Content
      </Dialog>,
    );
    fireEvent(screen.getByTestId("dialog"), new Event(type, { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps guarded child cancellation from reaching the parent", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <Dialog open title="Outer" onClose={outerClose}>
        <Dialog open title="Inner" onClose={innerClose} cancelGuard={() => true} testId="inner">
          Picker open
        </Dialog>
      </Dialog>,
    );
    const event = new Event("cancel", { cancelable: true });
    fireEvent(screen.getByTestId("inner"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(innerClose).not.toHaveBeenCalled();
    expect(outerClose).not.toHaveBeenCalled();
  });
});
