import { useEffect, useRef, useState } from "react";
import { useBufferFlag } from "../BufferContext.js";

export interface BufferedText {
  text: string;
  onChange: (next: string) => void;
  localError: string | null;
}

/**
 * Controlled text that only commits values passing `validate`. Invalid text
 * stays local (so the user can finish typing), is reported to the parent
 * buffer gate, and is replaced when the document value changes externally.
 */
export function useBufferedText(
  value: string,
  validate: (next: string) => string | null,
  onCommit: (next: string) => void,
  bufferKey: string,
): BufferedText {
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

  const onChange = (next: string): void => {
    setText(next);
    const error = validateRef.current(next);
    setLocalError(error);
    if (error !== null) return;
    lastValue.current = next;
    commitRef.current(next);
  };

  return { text, onChange, localError };
}
