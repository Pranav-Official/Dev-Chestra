import type { EffectiveTier } from "@devchestra/api";
import type { ModelTierId } from "@devchestra/schema";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";

export type TierMapping = NonNullable<EffectiveTier["mapping"]>;

export interface EffectiveTiers {
  /** Null until the first answer arrives, or when the server could not be asked. */
  mappings: Readonly<Record<ModelTierId, TierMapping | null>> | null;
  loading: boolean;
  failed: boolean;
}

/**
 * What each tier resolves to on this machine, for the agent form. Plain state rather than
 * react-query so the inspector keeps working without a QueryClientProvider, like its
 * sibling hooks. Re-asks when the window regains focus, so a mapping saved in the settings
 * tab shows up here without a reload.
 */
export function useEffectiveTiers(projectId: string | undefined, enabled = true): EffectiveTiers {
  const [state, setState] = useState<EffectiveTiers>({
    mappings: null,
    loading: projectId !== undefined && enabled,
    failed: false,
  });

  const load = useCallback(
    (isCancelled: () => boolean) => {
      if (projectId === undefined || !enabled) return;
      api
        .getEffectiveSettings(projectId)
        .then((response) => {
          if (isCancelled()) return;
          const mappings = { high: null, medium: null, low: null } as Record<
            ModelTierId,
            TierMapping | null
          >;
          for (const entry of response.tiers) mappings[entry.tier] = entry.mapping;
          setState({ mappings, loading: false, failed: false });
        })
        .catch(() => {
          if (!isCancelled()) setState({ mappings: null, loading: false, failed: true });
        });
    },
    [projectId, enabled],
  );

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

  return state;
}

/** "This machine" or "Project settings": where a tier's mapping came from. */
export function sourceLabel(source: TierMapping["source"]): string {
  return source === "local" ? "This machine" : "Project settings";
}
