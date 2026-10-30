import type { UsageProviderSummary } from "@devchestra/api";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { queryKeys } from "../api/hooks.js";
import { formatCost, formatTokens } from "../ui/format.js";
import { LoadingState } from "../ui/states.js";

const CHART_SERIES = 8;

/** Series colour by position; `--chart-*` tokens keep both themes legible. */
function colorAt(index: number): string {
  return `var(--chart-${(index % CHART_SERIES) + 1})`;
}

/** Locale-independent grouping — never en-IN style. */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function shortModel(provider: string, model: string): string {
  if (provider === "unknown" && model === "unknown") return "unattributed";
  if (model === "unknown") return provider;
  // Strip redundant provider prefix ("opencode-go/muse-spark…" → "muse-spark…").
  const tail = model.split("/").pop() ?? model;
  return provider === "unknown" ? tail : `${provider} / ${tail}`;
}

/** Providers in display order; the same index drives bar and dot colours. */
function ProviderBars({ providers }: { providers: UsageProviderSummary[] }) {
  if (providers.length === 0) return <p className="faint">No provider data yet.</p>;
  const totalTokens = providers.reduce((sum, p) => sum + p.tokens, 0);
  const max = Math.max(1, ...providers.map((p) => p.tokens));
  return (
    <ul className="usage-list">
      {providers.map((item, index) => {
        const color = colorAt(index);
        const pct = totalTokens > 0 ? (item.tokens / totalTokens) * 100 : 0;
        const pctLabel = pct >= 0.1 || pct === 0 ? pct.toFixed(1) : "<0.1";
        return (
          <li key={item.provider} className="usage-row">
            <div className="usage-row-head">
              <span className="usage-name">
                <span aria-hidden="true" className="usage-dot" style={{ background: color }} />
                <span className="usage-name-text mono" title={item.provider}>
                  {item.provider}
                </span>
              </span>
              <span className="usage-figures">
                <span className="mono">
                  {formatTokens(item.tokens)} <span className="faint">({pctLabel}%)</span>
                </span>
                <span className="mono muted">{formatCost(item.usd)}</span>
              </span>
            </div>
            <span
              role="img"
              aria-label={`${item.provider}: ${formatCount(item.tokens)} tokens`}
              className="usage-bar"
            >
              <span
                className="usage-bar-fill"
                style={{
                  width: `${Math.max(1.5, (item.tokens / max) * 100)}%`,
                  background: color,
                }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CostDonut({ providers }: { providers: UsageProviderSummary[] }) {
  const models = providers
    .flatMap((p) => p.byModel.map((m) => ({ ...m, provider: p.provider })))
    .filter((m) => m.usd > 0 || m.tokens > 0)
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  const total = models.reduce((sum, item) => sum + item.usd, 0);
  if (models.length === 0 || total <= 0) return <p className="faint">No cost data yet.</p>;

  let cursor = 0;
  const segments = models.flatMap((item, index) => {
    if (item.usd <= 0) return [];
    const start = (cursor / total) * 100;
    cursor += item.usd;
    const end = (cursor / total) * 100;
    return [`${colorAt(index)} ${start.toFixed(2)}% ${end.toFixed(2)}%`];
  });

  return (
    <div className="donut-layout">
      <div className="donut">
        <div
          role="img"
          aria-label="Cost by model donut chart"
          className="donut-ring"
          style={{ background: `conic-gradient(${segments.join(", ")})` }}
        />
        <div aria-hidden="true" className="donut-center">
          <span className="faint donut-center-label">Total</span>
          <span className="donut-center-value">{formatCost(total)}</span>
        </div>
      </div>

      <ul className="donut-models">
        {models.map((item, index) => {
          const share = (item.usd / total) * 100;
          const label = shortModel(item.provider, item.model);
          return (
            <li key={`${item.provider}/${item.model}`} className="donut-model">
              <span className="usage-name">
                <span
                  aria-hidden="true"
                  className="usage-swatch"
                  style={{ background: colorAt(index) }}
                />
                <span className="usage-name-text mono" title={label}>
                  {label}
                </span>
              </span>
              <span className="usage-figures">
                <span className="faint mono">{formatTokens(item.tokens)} tok</span>
                <span className="mono">
                  <span className="usage-cost">{formatCost(item.usd)}</span>{" "}
                  <span className="faint">· {share.toFixed(1)}%</span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function UsagePanel() {
  const { pid } = useParams();
  const projectId = pid || undefined;
  const usage = useQuery({
    queryKey: queryKeys.usage(projectId),
    queryFn: ({ signal }) => api.getUsage({ projectId }, { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  if (usage.isPending) return <LoadingState label="Loading usage…" />;
  if (usage.isError)
    return (
      <div>
        <p role="alert">Couldn't load usage analytics.</p>
        <button type="button" className="btn sm" onClick={() => void usage.refetch()}>
          Retry
        </button>
      </div>
    );
  const data = usage.data;
  // Zero-activity providers (e.g. decision/loop executions with no tokens or
  // cost) are hidden so both cards agree.
  const providers = data.byProvider
    .filter((p) => p.usd > 0 || p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || b.usd - a.usd);

  return (
    <div className="stack">
      <div className="usage-stats">
        <div className="stat usage-stat">
          <div className="faint">Total tokens</div>
          <div className="v">{formatCount(data.total.tokens)}</div>
        </div>
        <div className="stat usage-stat">
          <div className="faint">Total cost</div>
          <div className="v">{formatCost(data.total.usd)}</div>
        </div>
        <div className="stat usage-stat">
          <div className="faint">Providers</div>
          <div className="v">{providers.length}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head usage-card-head">
          <h2>Tokens by provider</h2>
          <span className="faint usage-card-caption">Volume &amp; spend per harness</span>
        </div>
        <div className="card-body usage-card-body">
          <ProviderBars providers={providers} />
        </div>
      </div>

      <div className="card">
        <div className="card-head usage-card-head">
          <h2>Cost by model</h2>
          <span className="faint usage-card-caption">Spend share across models</span>
        </div>
        <div className="card-body usage-card-body">
          <CostDonut providers={providers} />
        </div>
      </div>

      <p className="faint usage-footnote">
        Totals are run-level; per-provider breakdown reflects the latest attempt per node.
      </p>
    </div>
  );
}
