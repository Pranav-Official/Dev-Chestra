import { type ReactNode, useState } from "react";

const OPEN_STATE = new Map<string, boolean>();

/** Opens an inspector section on the next render that mounts it. */
export function openInspectorSection(sectionKey: string): void {
  OPEN_STATE.set(sectionKey, true);
}

export function InspectorSection({
  sectionKey,
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  sectionKey: string;
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => OPEN_STATE.get(sectionKey) ?? defaultOpen);
  return (
    <details
      className="inspector-section"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        OPEN_STATE.set(sectionKey, next);
      }}
    >
      <summary className="inspector-section-summary">
        <span>{title}</span>
        {badge === undefined ? null : <span className="inspector-section-badge">{badge}</span>}
      </summary>
      <div className="inspector-section-body">{children}</div>
    </details>
  );
}
