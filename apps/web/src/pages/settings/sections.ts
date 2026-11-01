import { BarChart3, Plug } from "lucide-react";

/** Settings pages in nav order. The page and the sidebar menu both read this list. */
export const SETTINGS_SECTIONS = [
  { id: "providers", label: "Providers", icon: Plug },
  { id: "usage", label: "Usage", icon: BarChart3 },
] as const;

export function settingsPath(pid: string | undefined, id: string): string {
  return pid !== undefined && pid !== "" ? `/p/${pid}/settings/${id}` : `/settings/${id}`;
}
