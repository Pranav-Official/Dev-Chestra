import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useBootstrap } from "../api/hooks.js";
import { formatCost, formatTokens } from "../ui/format.js";
import { LoadingState } from "../ui/states.js";
import { settingsPath } from "./settings/sections.js";

export interface UsageByModel {
  model: string;
  usd: number;
  tokens: number;
}

export interface UsageByProvider {
  provider: string;
  usd: number;
  tokens: number;
  byModel: UsageByModel[];
}

export interface UsageSummary {
  total: { usd: number; tokens: number };
  byProvider: UsageByProvider[];
}

const PALETTE = [
  "#7c6cf0",
  "#4cc38a",
  "#f0a35e",
  "#5aa9e6",
  "#e67fb1",
  "#e5c548",
  "#3ec6c6",
  "#e26d6d",
];

function colorAt(index: number): string {
  return PALETTE[index % PALETTE.length] ?? "#7c6cf0";
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

async function fetchUsageSummary(
  projectId: string | undefined,
  { signal }: { signal: AbortSignal },
): Promise<UsageSummary> {
  const params = new URLSearchParams();
  if (projectId !== undefined) {
    params.set("scope", "project");
    params.set("projectId", projectId);
  }
  const query = params.size > 0 ? `?${params}` : "";
  const response = await fetch(`/api/usage${query}`, { signal });
  if (!response.ok) throw new Error(`Usage request failed (${response.status})`);
  return (await response.json()) as UsageSummary;
}

function buildColorMap(providers: UsageByProvider[]): Map<string, string> {
  const sorted = [...providers].sort((a, b) => b.tokens - a.tokens || b.usd - a.usd);
  const map = new Map<string, string>();
  sorted.forEach((p, idx) => {
    map.set(p.provider, colorAt(idx));
  });
  return map;
}

function ProviderBars({
  providers,
  colorMap,
}: {
  providers: UsageByProvider[];
  colorMap: Map<string, string>;
}) {
  const rows = [...providers].sort((a, b) => b.tokens - a.tokens);
  const totalTokens = rows.reduce((sum, p) => sum + p.tokens, 0);
  const max = Math.max(1, ...rows.map((p) => p.tokens));
  if (rows.length === 0) return <p className="faint">No provider data yet.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
      {rows.map((item, index) => {
        const color = colorMap.get(item.provider) ?? colorAt(index);
        const pct = totalTokens > 0 ? (item.tokens / totalTokens) * 100 : 0;
        return (
          <li key={item.provider} style={{ display: "grid", gap: 6 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 1fr) auto auto",
                gap: 16,
                alignItems: "baseline",
              }}
            >
              <span className="row" style={{ gap: 8, minWidth: 0 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    flex: "none",
                    background: color,
                  }}
                />
                <span
                  className="mono"
                  style={{
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={item.provider}
                >
                  {item.provider}
                </span>
              </span>
              <span
                className="mono"
                style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}
              >
                {formatTokens(item.tokens)}{" "}
                <span className="faint">
                  ({pct >= 0.1 || pct === 0 ? pct.toFixed(1) : "<0.1"}%)
                </span>
              </span>
              <span
                className="mono muted"
                style={{
                  minWidth: 68,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatCost(item.usd)}
              </span>
            </div>
            <span
              role="img"
              aria-label={`${item.provider}: ${formatCount(item.tokens)} tokens`}
              style={{
                display: "block",
                height: 8,
                borderRadius: 999,
                background: "var(--bg-muted)",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${Math.max(1.5, (item.tokens / max) * 100)}%`,
                  borderRadius: 999,
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

function CostDonut({
  providers,
  colorMap,
}: {
  providers: UsageByProvider[];
  colorMap: Map<string, string>;
}) {
  const models = providers
    .flatMap((p) => p.byModel.map((m) => ({ ...m, provider: p.provider })))
    .filter((m) => m.usd > 0 || m.tokens > 0)
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  const total = models.reduce((sum, item) => sum + item.usd, 0);
  if (models.length === 0 || total <= 0) return <p className="faint">No cost data yet.</p>;

  const modelColors = models.map((item, index) => {
    const sameProviderCount = models.filter((m) => m.provider === item.provider).length;
    if (sameProviderCount === 1) {
      return colorMap.get(item.provider) ?? colorAt(index);
    }
    return colorAt(index);
  });

  let cursor = 0;
  const segments = models
    .map((item, index) => {
      if (item.usd <= 0) return null;
      const start = (cursor / total) * 100;
      cursor += item.usd;
      const end = (cursor / total) * 100;
      return `${modelColors[index]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    })
    .filter((s): s is string => s !== null);

  return (
    <div className="row wrap" style={{ gap: 28, alignItems: "center" }}>
      <div
        style={{
          position: "relative",
          width: 148,
          height: 148,
          display: "grid",
          placeItems: "center",
          flex: "none",
          margin: "0 auto",
        }}
      >
        <div
          role="img"
          aria-label="Cost by model donut chart"
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            background: `conic-gradient(${segments.join(", ")})`,
            mask: "radial-gradient(circle, transparent 58%, black 59.5%)",
            WebkitMask: "radial-gradient(circle, transparent 58%, black 59.5%)",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            textAlign: "center",
            pointerEvents: "none",
            lineHeight: 1.2,
          }}
        >
          <div className="faint" style={{ fontSize: 11 }}>
            Total
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.015em" }}>
            {formatCost(total)}
          </div>
        </div>
      </div>

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: 10,
          flex: "1 1 260px",
        }}
      >
        {models.map((item, index) => {
          const share = (item.usd / total) * 100;
          return (
            <li
              key={`${item.provider}/${item.model}`}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(140px, 1fr) auto auto",
                gap: 14,
                alignItems: "center",
                paddingBottom: index < models.length - 1 ? 10 : 0,
                borderBottom: index < models.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <span className="row" style={{ gap: 8, minWidth: 0 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    flex: "none",
                    background: modelColors[index],
                  }}
                />
                <span
                  className="mono"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={shortModel(item.provider, item.model)}
                >
                  {shortModel(item.provider, item.model)}
                </span>
              </span>
              <span
                className="faint mono"
                style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}
              >
                {formatTokens(item.tokens)} tok
              </span>
              <span
                className="mono"
                style={{
                  minWidth: 108,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ fontWeight: 500 }}>{formatCost(item.usd)}</span>{" "}
                <span className="faint">· {share.toFixed(1)}%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Usage is project-scoped under /p/:pid/settings and global under /settings, and the
 * sidebar's Settings link keeps the current project. Say which one this is, and let
 * the reader switch, so a project's totals are never mistaken for the whole picture.
 */
function UsageScope({ projectId }: { projectId: string | undefined }) {
  const bootstrap = useBootstrap();
  if (projectId === undefined) {
    return (
      <p className="faint" style={{ margin: 0 }}>
        Showing usage across all projects.
      </p>
    );
  }
  const name = bootstrap.data?.projects.find((project) => project.id === projectId)?.name;
  return (
    <nav className="tabs" style={{ padding: 0 }} aria-label="Usage scope">
      <Link className="tab" to={settingsPath(undefined, "usage")}>
        All projects
      </Link>
      <Link className="tab active" to={settingsPath(projectId, "usage")} aria-current="page">
        {name ?? "This project"}
      </Link>
    </nav>
  );
}

export function UsagePanel() {
  const { pid } = useParams();
  const projectId = pid !== "" && pid !== undefined ? pid : undefined;
  const usage = useQuery({
    queryKey: ["usage", projectId ?? "global"],
    queryFn: ({ signal }) => fetchUsageSummary(projectId, { signal }),
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
  const providers = data.byProvider.filter((p) => p.usd > 0 || p.tokens > 0);
  const colorMap = buildColorMap(providers);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <UsageScope projectId={projectId} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 12,
        }}
      >
        <div className="stat" style={{ background: "var(--bg-subtle)" }}>
          <div className="faint">Total tokens</div>
          <div className="v" style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCount(data.total.tokens)}
          </div>
          <div className="faint mono" style={{ marginTop: 4, fontSize: 11 }}>
            {formatTokens(data.total.tokens)} processed
          </div>
        </div>
        <div className="stat" style={{ background: "var(--bg-subtle)" }}>
          <div className="faint">Total cost</div>
          <div className="v" style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCost(data.total.usd)}
          </div>
          <div className="faint mono" style={{ marginTop: 4, fontSize: 11 }}>
            Cumulative spend
          </div>
        </div>
        <div className="stat" style={{ background: "var(--bg-subtle)" }}>
          <div className="faint">Providers</div>
          <div className="v" style={{ fontVariantNumeric: "tabular-nums" }}>
            {providers.length}
          </div>
          <div className="faint mono" style={{ marginTop: 4, fontSize: 11 }}>
            Active harnesses
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Tokens by provider</h2>
          <span className="faint" style={{ fontSize: 12, fontWeight: 400 }}>
            Volume &amp; spend per harness
          </span>
        </div>
        <div className="card-body" style={{ padding: "16px 18px" }}>
          <ProviderBars providers={providers} colorMap={colorMap} />
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Cost by model</h2>
          <span className="faint" style={{ fontSize: 12, fontWeight: 400 }}>
            Spend share across models
          </span>
        </div>
        <div className="card-body" style={{ padding: "18px" }}>
          <CostDonut providers={providers} colorMap={colorMap} />
        </div>
      </div>
      <p className="faint" style={{ margin: 0 }}>
        Totals are run-level; per-provider breakdown reflects the latest attempt per node.
      </p>
    </div>
  );
}
