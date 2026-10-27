import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useBufferFlag } from "../BufferContext.js";

export interface BufferedHandle {
  text: string;
  localError: string | null;
  onChange(next: string): void;
  onBlur(): void;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
}

/**
 * Handle ids are edge endpoints, so they commit on blur/Enter instead of on
 * every keystroke. Partial text never rewrites the document or remounts the row.
 */
export function useBufferedHandle(
  value: string,
  validate: (next: string) => string | null,
  onCommit: (next: string) => void,
  bufferKey: string,
): BufferedHandle {
  const [text, setText] = useState(value);
  const [localError, setLocalError] = useState<string | null>(() => validate(value));
  const lastValue = useRef(value);
  const validateRef = useRef(validate);
  const commitRef = useRef(onCommit);
  validateRef.current = validate;
  commitRef.current = onCommit;

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    setText(value);
    setLocalError(validateRef.current(value));
  }, [value]);

  useBufferFlag(bufferKey, localError);

  const commit = (): void => {
    const error = validateRef.current(text);
    setLocalError(error);
    if (error !== null || text === lastValue.current) return;
    lastValue.current = text;
    commitRef.current(text);
  };

  return {
    text,
    localError,
    onChange(next) {
      setText(next);
      setLocalError(validateRef.current(next));
    },
    onBlur: commit,
    onKeyDown(event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    },
  };
}
