import { type Runtime, withReadTx } from "./runtime.js";
import type { UsageFilter, UsageProviderSummary, UsageSummary } from "./types.js";

const UNKNOWN = "unknown";

interface TotalRow {
  usd: number;
  tokens: number;
}

interface BreakdownRow {
  provider: string | null;
  model: string | null;
  usd: number;
  tokens: number;
}

function label(value: string | null): string {
  return value === null || value === "" ? UNKNOWN : value;
}

/**
 * Aggregated usage for the browser API.
 *
 * - `total` comes from the runs table (authoritative run-level cost/tokens).
 * - `byProvider` comes from executions (`SUM(cost_usd)`,
 *   `SUM(tokens_in + tokens_out)` grouped by `cli`, `model`), nested by
 *   provider with per-model rows.
 *
 * A `projectId` filter scopes both reads (executions via their parent run).
 * Providers/models sort by spend descending; models nest under their provider.
 */
export function getUsageSummary(runtime: Runtime, filter: UsageFilter = {}): UsageSummary {
  return withReadTx(runtime, () => {
    const params: unknown[] = [];
    let runsWhere = "";
    let executionsWhere = "";
    if (filter.projectId !== undefined) {
      runsWhere = "WHERE project_id = ?";
      executionsWhere = "WHERE r.project_id = ?";
      params.push(filter.projectId);
    }

    const total = runtime.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(tokens), 0) AS tokens
           FROM runs ${runsWhere}`,
      )
      .get(...params) as TotalRow;

    const rows = runtime.db
      .prepare(
        `SELECT e.cli AS provider, e.model AS model,
                COALESCE(SUM(e.cost_usd), 0) AS usd,
                COALESCE(SUM(e.tokens_in + e.tokens_out), 0) AS tokens
           FROM executions e JOIN runs r ON r.id = e.run_id
          ${executionsWhere}
          GROUP BY e.cli, e.model
          ORDER BY usd DESC, tokens DESC`,
      )
      .all(...params) as BreakdownRow[];

    const providers = new Map<string, UsageProviderSummary>();
    for (const row of rows) {
      const provider = label(row.provider);
      const existing = providers.get(provider);
      const entry = { model: label(row.model), usd: row.usd, tokens: row.tokens };
      if (existing === undefined) {
        providers.set(provider, {
          provider,
          usd: row.usd,
          tokens: row.tokens,
          byModel: [entry],
        });
      } else {
        existing.usd += row.usd;
        existing.tokens += row.tokens;
        existing.byModel.push(entry);
      }
    }
    const byProvider = [...providers.values()].sort(
      (left, right) => right.usd - left.usd || right.tokens - left.tokens,
    );

    return {
      total: { usd: total.usd, tokens: total.tokens },
      byProvider,
    };
  });
}
