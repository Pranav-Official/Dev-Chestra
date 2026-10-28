import { create } from "zustand";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "devchestra.theme";

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemDark() ? "dark" : "light") : mode;
}

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(mode);
  root.dataset.themeMode = mode;
  if (mode === "system") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // UI preference only; storage may be unavailable.
    }
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // UI preference only.
    }
  }
}

export function initTheme(): ThemeMode {
  const mode = readMode();
  applyTheme(mode);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (useUiStore.getState().mode === "system") applyTheme("system");
  });
  return mode;
}

export function nextTheme(mode: ThemeMode): ThemeMode {
  if (mode === "system") return "light";
  if (mode === "light") return "dark";
  return "system";
}

interface UiState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  cycleTheme: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  mode: readMode(),
  setMode: (mode) => {
    applyTheme(mode);
    set({ mode });
  },
  cycleTheme: () => get().setMode(nextTheme(get().mode)),
}));
