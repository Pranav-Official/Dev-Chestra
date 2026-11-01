import "../styles/settings-providers.css";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name, e.g. "Turn off Codex". */
  label: string;
  disabled?: boolean;
  title?: string;
  testId?: string;
}

export function Switch({ checked, onChange, label, disabled, title, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className="switch"
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
