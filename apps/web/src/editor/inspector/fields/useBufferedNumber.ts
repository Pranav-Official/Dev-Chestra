import { useEffect, useRef, useState } from "react";
import { useBufferFlag } from "../BufferContext.js";

export interface BufferedNumber {
  text: string;
  onChange: (next: string) => void;
  localError: string | null;
}

export interface BufferedNumberOptions {
  label: string;
  min: number;
  max: number;
  /** Whole numbers only (limits, array bounds). */
  integer?: boolean;
  /** Blank means "not set" for optional fields. */
  allowEmpty: boolean;
  onCommit: (value: number | undefined) => void;
  bufferKey: string;
}

function blankText(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function rangeText(options: BufferedNumberOptions): string {
  if (!Number.isFinite(options.min) || !Number.isFinite(options.max)) return "a finite number";
  return `between ${options.min} and ${options.max}`;
}

function check(text: string, options: BufferedNumberOptions): string | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return options.allowEmpty ? null : `${options.label} is required.`;
  }
  const parsed = Number(trimmed);
  const validNumber =
    options.integer === false ? Number.isFinite(parsed) : Number.isSafeInteger(parsed);
  if (!validNumber) {
    return `${options.label} must be a ${options.integer === false ? "finite number" : "whole number"}.`;
  }
  if (parsed < options.min || parsed > options.max) {
    return `${options.label} must be ${rangeText(options)}.`;
  }
  return null;
}

/**
 * Number text buffer. Never emits NaN or null: invalid text stays local and
 * blocks the parent's Save/Run gate until it can be committed.
 */
export function useBufferedNumber(
  value: number | undefined,
  options: BufferedNumberOptions,
): BufferedNumber {
  const [text, setText] = useState(() => blankText(value));
  const [localError, setLocalError] = useState<string | null>(() =>
    check(blankText(value), options),
  );
  const lastValue = useRef(value);
  const lastSent = useRef(value);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    lastSent.current = value;
    setText(blankText(value));
    setLocalError(check(blankText(value), optionsRef.current));
  }, [value]);

  useBufferFlag(options.bufferKey, localError);

  const onChange = (next: string): void => {
    setText(next);
    const error = check(next, optionsRef.current);
    setLocalError(error);
    if (error !== null) return;
    const trimmed = next.trim();
    const resolved = trimmed === "" ? undefined : Number(trimmed);
    if (resolved === lastSent.current) return;
    lastSent.current = resolved;
    lastValue.current = resolved;
    optionsRef.current.onCommit(resolved);
  };

  return { text, onChange, localError };
}
