import { useQuery } from "@tanstack/react-query";
import { formatCost, formatTokens } from "../ui/format.js";
import { LoadingState } from "../ui/states.js";
import { ProjectUsage } from "./usage/ProjectUsage.js";
import {
  buildColorMap,
  colorAt,
  formatCount,
  ProviderBars,
  type UsageByProvider,
  type UsageSummary,
} from "./usage/shared.js";

function shortModel(provider: string, model: string): string {
  if (provider === "unknown" && model === "unknown") return "unattributed";
  if (model === "unknown") return provider;
  // Strip redundant provider prefix ("opencode-go/muse-spark…" → "muse-spark…").
  const tail = model.split("/").pop() ?? model;
  return provider === "unknown" ? tail : `${provider} / ${tail}`;
}

/** Usage is always the overall picture; a single project's split is drilled into on the page. */
async function fetchUsageSummary({ signal }: { signal: AbortSignal }): Promise<UsageSummary> {
  const response = await fetch("/api/usage", { signal });
  if (!response.ok) throw new Error(`Usage request failed (${response.status})`);
  return (await response.json()) as UsageSummary;
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

export function UsagePanel() {
  const usage = useQuery({
    queryKey: ["usage", "global"],
    queryFn: ({ signal }) => fetchUsageSummary({ signal }),
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

      <ProjectUsage projects={data.byProject} colorMap={colorMap} />

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
