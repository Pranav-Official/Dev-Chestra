import type { CliListItem } from "@devchestra/api";
import { type AgentCli, isProdCliId, PROD_CLI_LABELS, PROD_CLIS } from "@devchestra/schema";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";

const HELP = "Real CLI adapter. Not an OS sandbox; permissions are advisory.";

export interface AvailableCli extends Pick<CliListItem, "id" | "label"> {
  id: AgentCli;
  help: string;
  /** False when the provider is turned off in Settings. Turned-off providers stay listed so a node that still uses one can show why it is blocked. */
  enabled: boolean;
}

function fallback(): AvailableCli[] {
  return PROD_CLIS.map((id) => ({ id, label: PROD_CLI_LABELS[id], help: HELP, enabled: true }));
}

/** Registry-backed CLI list; falls back to the static prod registry offline.
 * Refetches when the window regains focus, so a provider switch flipped in Settings
 * (often another tab) shows up without a reload. */
export function useAvailableClis(): { clis: AvailableCli[]; loading: boolean } {
  const [clis, setClis] = useState<AvailableCli[]>(() => fallback());
  const [loading, setLoading] = useState(true);

  const load = useCallback((isCancelled: () => boolean) => {
    api
      .listClis()
      .then((response) => {
        if (isCancelled()) return;
        const items = response.clis.filter((entry): entry is CliListItem & { id: AgentCli } =>
          isProdCliId(entry.id),
        );
        if (items.length > 0) {
          setClis(
            items.map((entry) => ({
              id: entry.id,
              label: entry.label,
              help: HELP,
              // Older servers and test doubles omit the flag: treat that as on.
              enabled: entry.enabled !== false,
            })),
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!isCancelled()) setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    load(isCancelled);
    const onFocus = () => load(isCancelled);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return { clis, loading };
}
