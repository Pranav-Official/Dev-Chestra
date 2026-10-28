import { AlertCircle, Info } from "lucide-react";
import type { ReactNode } from "react";

export function describedBy(id: string, help?: string, error?: string | null): string | undefined {
  const ids = [help === undefined ? null : `${id}-help`, error ? `${id}-error` : null].filter(
    (entry): entry is string => entry !== null,
  );
  return ids.length === 0 ? undefined : ids.join(" ");
}

/** Help text lives behind an info icon so forms stay quiet; the text stays in the DOM for assistive tech. */
export function InfoTip({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className="inspector-tip">
      <button
        type="button"
        className="inspector-tip-btn"
        aria-label="More info"
        aria-describedby={id}
      >
        <Info size={12} aria-hidden="true" />
      </button>
      <span className="inspector-tip-pop" id={id} role="tooltip">
        {children}
      </span>
    </span>
  );
}

export function Field({
  id,
  label,
  help,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | null | undefined;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="inspector-field">
      <div className="inspector-label-row">
        <label className="inspector-label" htmlFor={id}>
          {label}
          {required ? (
            <span className="inspector-required" aria-hidden="true">
              {" "}
              *
            </span>
          ) : null}
        </label>
        {help === undefined ? null : <InfoTip id={`${id}-help`}>{help}</InfoTip>}
      </div>
      {children}
      {error ? (
        <p className="inspector-error" id={`${id}-error`} role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange,
  disabled = false,
  help,
  error,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  help?: string | undefined;
  error?: string | null | undefined;
}) {
  return (
    <div className="inspector-field inspector-check-field inspector-toggle">
      <div className="inspector-check">
        <input
          id={id}
          data-testid={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, help, error)}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <label htmlFor={id}>{label}</label>
        {help === undefined ? null : <InfoTip id={`${id}-help`}>{help}</InfoTip>}
      </div>
      {error ? (
        <p className="inspector-error" id={`${id}-error`} role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
