import { Monitor, Moon, Sun } from "lucide-react";
import { useUiStore } from "../state/uiStore.js";

export function ThemeToggle() {
  const mode = useUiStore((state) => state.mode);
  const cycleTheme = useUiStore((state) => state.cycleTheme);
  const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun;
  return (
    <button
      type="button"
      className="btn ghost icon sm"
      onClick={cycleTheme}
      aria-label={`Theme: ${mode}`}
      title={`Theme: ${mode}. Click to change.`}
      data-testid="theme-toggle"
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}
