import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

/**
 * A read-only value with a copy button. Focusing the value selects all of it,
 * so a copy that the browser blocks can still be done by hand.
 */
export function CopyField({
  label,
  value,
  copyLabel,
  testId,
}: {
  label: string;
  value: string;
  copyLabel: string;
  testId: string;
}) {
  const id = useId();
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="webhook-copy">
      <label className="webhook-copy-label" htmlFor={id}>
        {label}
      </label>
      <div className="webhook-copy-row">
        <input
          id={id}
          className="input mono"
          readOnly
          value={value}
          data-testid={testId}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="btn sm" aria-label={copyLabel} onClick={() => void copy()}>
          {state === "copied" ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Copy size={13} aria-hidden="true" />
          )}
          {state === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {state === "failed" ? (
        <p className="webhook-copy-error" role="alert">
          Copy did not work. Select the value and copy it by hand.
        </p>
      ) : null}
    </div>
  );
}
