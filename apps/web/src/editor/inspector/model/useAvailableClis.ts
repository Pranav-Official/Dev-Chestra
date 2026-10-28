import type { CliListItem } from "@relay/api";
import { type AgentCli, PROD_CLIS } from "@relay/schema";
import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";

const LABELS: Record<AgentCli, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "Opencode",
  pi: "Pi",
};

const HELP = "Real CLI adapter. Not an OS sandbox; enforcement is unverified.";

export interface AvailableCli extends Pick<CliListItem, "id" | "label"> {
  id: AgentCli;
  help: string;
}

function fallback(): AvailableCli[] {
  return PROD_CLIS.map((id) => ({ id, label: LABELS[id], help: HELP }));
}

/** Registry-backed CLI list; falls back to the static prod registry offline. */
export function useAvailableClis(): { clis: AvailableCli[]; loading: boolean } {
  const [clis, setClis] = useState<AvailableCli[]>(() => fallback());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .listClis()
      .then((response) => {
        if (cancelled) return;
        const items = response.clis.filter((entry): entry is CliListItem & { id: AgentCli } =>
          (PROD_CLIS as readonly string[]).includes(entry.id),
        );
        if (items.length > 0) {
          setClis(items.map((entry) => ({ id: entry.id, label: entry.label, help: HELP })));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { clis, loading };
}
