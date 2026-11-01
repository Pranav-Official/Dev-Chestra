import { BarChart3, Gauge, Plug } from "lucide-react";

/**
 * Settings pages in nav order. The page and the sidebar menu both read this list.
 * Every id also needs a route in app.tsx (global and under p/:pid) and a panel in SettingsPage.
 */
export const SETTINGS_SECTIONS = [
  { id: "providers", label: "Providers", icon: Plug },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "execution", label: "Execution", icon: Gauge },
] as const;

export function settingsPath(pid: string | undefined, id: string): string {
  return pid !== undefined && pid !== "" ? `/p/${pid}/settings/${id}` : `/settings/${id}`;
}
