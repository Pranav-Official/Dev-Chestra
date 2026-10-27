import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

export function describedBy(id: string, help?: string, error?: string | null): string | undefined {
  const ids = [help === undefined ? null : `${id}-help`, error ? `${id}-error` : null].filter(
    (entry): entry is string => entry !== null,
  );
  return ids.length === 0 ? undefined : ids.join(" ");
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
      <label className="inspector-label" htmlFor={id}>
        {label}
        {required ? (
          <span className="inspector-required" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {children}
      {help === undefined ? null : (
        <p className="inspector-help" id={`${id}-help`}>
          {help}
        </p>
      )}
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
    <div className="inspector-field inspector-check-field">
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
      </div>
      {help === undefined ? null : (
        <p className="inspector-help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error ? (
        <p className="inspector-error" id={`${id}-error`} role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
