import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "../src/ui/Switch.js";

describe("Switch", () => {
  it("renders a labelled switch with its state", () => {
    render(<Switch checked label="Turn off Codex" onChange={() => undefined} />);
    const toggle = screen.getByRole("switch", { name: "Turn off Codex" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAttribute("type", "button");
  });

  it("calls onChange with the opposite value on click", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Turn on Codex" onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Turn on Codex" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not call onChange when disabled", () => {
    const onChange = vi.fn();
    render(
      <Switch
        checked
        disabled
        title="At least one provider must stay on"
        label="Turn off Pi"
        onChange={onChange}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Turn off Pi" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "At least one provider must stay on");
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("exposes the test id when given", () => {
    render(
      <Switch
        checked={false}
        label="Turn on Pi"
        testId="provider-switch-pi"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByTestId("provider-switch-pi")).toHaveAttribute("role", "switch");
  });
});
