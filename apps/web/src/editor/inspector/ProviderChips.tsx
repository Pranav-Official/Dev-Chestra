import type { AgentCli } from "@devchestra/schema";
import { type KeyboardEvent, useRef } from "react";
import "../../styles/editor-model-picker.css";
import { ProviderIcon } from "../../ui/ProviderIcon.js";
import type { AvailableCli } from "./model/useAvailableClis.js";

export interface ProviderChipsProps {
  clis: AvailableCli[];
  value: AgentCli;
  onSelect(cli: AgentCli): void;
  invalid?: boolean;
  describedBy?: string | undefined;
}

/** The next enabled entry from `from`, wrapping around; `from` may be -1 when nothing is selected. */
function stepEnabled(list: readonly AvailableCli[], from: number, step: 1 | -1) {
  for (let offset = 1; offset <= list.length; offset += 1) {
    const index = (((from + step * offset) % list.length) + list.length) % list.length;
    const candidate = list[index];
    if (candidate?.enabled) return candidate;
  }
  return undefined;
}

export function ProviderChips({
  clis,
  value,
  onSelect,
  invalid = false,
  describedBy,
}: ProviderChipsProps) {
  const buttons = useRef(new Map<AgentCli, HTMLButtonElement>());
  // A turned-off provider stays visible only while it is the selected one.
  const visible = clis.filter((entry) => entry.enabled || entry.id === value);
  const selectedIndex = visible.findIndex((entry) => entry.id === value);
  const fallbackFocus = visible.find((entry) => entry.enabled)?.id;

  const select = (next: AvailableCli | undefined) => {
    if (next === undefined) return;
    if (next.id !== value) onSelect(next.id);
    buttons.current.get(next.id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select(stepEnabled(visible, index, 1));
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select(stepEnabled(visible, index, -1));
        return;
      case "Home":
        event.preventDefault();
        select(visible.find((entry) => entry.enabled));
        return;
      case "End":
        event.preventDefault();
        select(visible.findLast((entry) => entry.enabled));
        return;
      default:
        return;
    }
  };

  return (
    <div
      className="provider-chips"
      role="radiogroup"
      aria-label="Provider"
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      data-testid="inspector-agent-cli"
    >
      {visible.map((entry, index) => {
        const selected = entry.id === value;
        const off = !entry.enabled;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled chips, not native radios; the radiogroup pattern is the spec
          <button
            key={entry.id}
            ref={(element) => {
              if (element === null) buttons.current.delete(entry.id);
              else buttons.current.set(entry.id, element);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (selectedIndex === -1 && entry.id === fallbackFocus) ? 0 : -1}
            className="provider-chip"
            data-selected={selected ? "true" : undefined}
            data-off={off ? "true" : undefined}
            data-testid={`inspector-agent-cli-${entry.id}`}
            onClick={() => {
              if (!selected) onSelect(entry.id);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <ProviderIcon cli={entry.id} size={14} />
            <span className="provider-chip-label">{entry.label}</span>
            {off ? <span className="provider-chip-off">Off</span> : null}
          </button>
        );
      })}
    </div>
  );
}
