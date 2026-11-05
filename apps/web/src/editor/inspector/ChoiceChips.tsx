import { type KeyboardEvent, useRef } from "react";
import "../../styles/editor-model-picker.css";

export interface ChoiceChip<T extends string> {
  id: T;
  label: string;
  /** Small text tag after the label, e.g. "Not set". Text, so state never rides on colour alone. */
  tag?: string | undefined;
}

export interface ChoiceChipsProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: readonly ChoiceChip<T>[];
  value: T | undefined;
  onSelect(next: T): void;
  /** Prefix of each chip's test id: `${testId}-${id}`. */
  testId: string;
  columns?: 2 | 3;
  describedBy?: string | undefined;
}

/**
 * A small radio group drawn as chips: one choice, arrow-key roving focus. Same look as the
 * provider chips; use it for short fixed lists such as the model source and the tier.
 */
export function ChoiceChips<T extends string>({
  label,
  options,
  value,
  onSelect,
  testId,
  columns = 2,
  describedBy,
}: ChoiceChipsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const selectedIndex = options.findIndex((option) => option.id === value);

  const select = (index: number) => {
    const target = options[(index + options.length) % options.length];
    if (target === undefined) return;
    if (target.id !== value) onSelect(target.id);
    buttons.current.get(target.id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select(index + 1);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select(index - 1);
        return;
      case "Home":
        event.preventDefault();
        select(0);
        return;
      case "End":
        event.preventDefault();
        select(options.length - 1);
        return;
      default:
        return;
    }
  };

  return (
    <div
      className="provider-chips"
      data-columns={columns}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled chips, not native radios; the radiogroup pattern is the spec
          <button
            key={option.id}
            ref={(element) => {
              if (element === null) buttons.current.delete(option.id);
              else buttons.current.set(option.id, element);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            className="provider-chip"
            data-selected={selected ? "true" : undefined}
            data-testid={`${testId}-${option.id}`}
            onClick={() => {
              if (!selected) onSelect(option.id);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className="provider-chip-label">{option.label}</span>
            {option.tag === undefined ? null : (
              <span className="provider-chip-off">{option.tag}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
