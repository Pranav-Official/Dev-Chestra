import { type Runtime, withReadTx } from "./runtime.js";
import type {
  UsageFilter,
  UsageProjectSummary,
  UsageProviderSummary,
  UsageSummary,
} from "./types.js";

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

interface ProjectTotalRow {
  projectId: string;
  name: string;
  removed: number;
  usd: number;
  tokens: number;
}

interface ProjectBreakdownRow extends BreakdownRow {
  projectId: string;
}

function label(value: string | null): string {
  return value === null || value === "" ? UNKNOWN : value;
}

/** Nests per-model rows under their provider; providers sort by spend descending. */
function groupProviders(rows: readonly BreakdownRow[]): UsageProviderSummary[] {
  const providers = new Map<string, UsageProviderSummary>();
  for (const row of rows) {
    const provider = label(row.provider);
    const existing = providers.get(provider);
    const entry = { model: label(row.model), usd: row.usd, tokens: row.tokens };
    if (existing === undefined) {
      providers.set(provider, { provider, usd: row.usd, tokens: row.tokens, byModel: [entry] });
    } else {
      existing.usd += row.usd;
      existing.tokens += row.tokens;
      existing.byModel.push(entry);
    }
  }
  return [...providers.values()].sort(
    (left, right) => right.usd - left.usd || right.tokens - left.tokens,
  );
}

/**
 * Aggregated usage for the browser API.
 *
 * - `total` comes from the runs table (authoritative run-level cost/tokens).
 * - `byProvider` comes from executions (`SUM(cost_usd)`,
 *   `SUM(tokens_in + tokens_out)` grouped by `cli`, `model`), nested by
 *   provider with per-model rows.
 * - `byProject` splits the same two reads by project. Removed projects are
 *   soft-deleted and keep their runs, so they are included (flagged) and the
 *   projects always add up to `total`.
 *
 * A `projectId` filter scopes both reads (executions via their parent run).
 * Providers/models sort by spend descending; models nest under their provider.
 */
export function getUsageSummary(runtime: Runtime, filter: UsageFilter = {}): UsageSummary {
  return withReadTx(runtime, () => {
    const params: unknown[] = [];
    const runsPredicates: string[] = [];
    const executionsPredicates: string[] = [];
    if (filter.projectId !== undefined) {
      runsPredicates.push("project_id = ?");
      executionsPredicates.push("r.project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.includeProbeRuns !== true) {
      runsPredicates.push("kind != 'poll_probe'");
      executionsPredicates.push("r.kind != 'poll_probe'");
    }
    const runsWhere = runsPredicates.length > 0 ? `WHERE ${runsPredicates.join(" AND ")}` : "";
    const executionsWhere =
      executionsPredicates.length > 0 ? `WHERE ${executionsPredicates.join(" AND ")}` : "";

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

    const projectTotals = runtime.db
      .prepare(
        `SELECT r.project_id AS projectId, p.name AS name,
                p.removed_at IS NOT NULL AS removed,
                COALESCE(SUM(r.cost_usd), 0) AS usd, COALESCE(SUM(r.tokens), 0) AS tokens
           FROM runs r JOIN projects p ON p.id = r.project_id
          ${executionsWhere}
          GROUP BY r.project_id`,
      )
      .all(...params) as ProjectTotalRow[];

    const projectRows = runtime.db
      .prepare(
        `SELECT r.project_id AS projectId, e.cli AS provider, e.model AS model,
                COALESCE(SUM(e.cost_usd), 0) AS usd,
                COALESCE(SUM(e.tokens_in + e.tokens_out), 0) AS tokens
           FROM executions e JOIN runs r ON r.id = e.run_id
          ${executionsWhere}
          GROUP BY r.project_id, e.cli, e.model
          ORDER BY usd DESC, tokens DESC`,
      )
      .all(...params) as ProjectBreakdownRow[];

    const rowsByProject = new Map<string, ProjectBreakdownRow[]>();
    for (const row of projectRows) {
      rowsByProject.set(row.projectId, [...(rowsByProject.get(row.projectId) ?? []), row]);
    }
    const byProject: UsageProjectSummary[] = projectTotals
      .map((project) => ({
        projectId: project.projectId,
        name: project.name,
        removed: project.removed === 1,
        usd: project.usd,
        tokens: project.tokens,
        byProvider: groupProviders(rowsByProject.get(project.projectId) ?? []),
      }))
      .sort(
        (left, right) =>
          right.usd - left.usd || right.tokens - left.tokens || left.name.localeCompare(right.name),
      );

    return {
      total: { usd: total.usd, tokens: total.tokens },
      byProvider: groupProviders(rows),
      byProject,
    };
  });
}
