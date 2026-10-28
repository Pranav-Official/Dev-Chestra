import type { DecisionProviderView } from "@devchestra/api";
import { DECISION_PROVIDERS } from "@devchestra/schema";
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";

export interface DecisionProviderState extends DecisionProviderView {
  unknown: boolean;
}

function offline(): DecisionProviderState[] {
  return DECISION_PROVIDERS.map((id) => ({
    id,
    label: id,
    ready: false,
    missing: [],
    unknown: true,
  }));
}

/** Fixed preset list with server-reported readiness; names only, never secrets. */
export function useDecisionProviders(): {
  providers: DecisionProviderState[];
  loading: boolean;
  failed: boolean;
} {
  const [providers, setProviders] = useState<DecisionProviderState[]>(() => offline());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listDecisionProviders()
      .then((response) => {
        if (cancelled) return;
        const byId = new Map(response.map((entry) => [entry.id, entry]));
        setProviders(
          DECISION_PROVIDERS.map((id) => {
            const entry = byId.get(id);
            if (entry === undefined)
              return { id, label: id, ready: false, missing: [], unknown: true };
            return { ...entry, unknown: false };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { providers, loading, failed };
}
