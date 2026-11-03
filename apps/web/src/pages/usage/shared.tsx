import { formatCost, formatTokens } from "../../ui/format.js";

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

export interface UsageByProject {
  projectId: string;
  name: string;
  /** A removed project keeps its runs, so it still counts toward the totals. */
  removed: boolean;
  usd: number;
  tokens: number;
  byProvider: UsageByProvider[];
}

export interface UsageSummary {
  total: { usd: number; tokens: number };
  byProvider: UsageByProvider[];
  byProject: UsageByProject[];
}

export const PALETTE = [
  "#7c6cf0",
  "#4cc38a",
  "#f0a35e",
  "#5aa9e6",
  "#e67fb1",
  "#e5c548",
  "#3ec6c6",
  "#e26d6d",
];

export function colorAt(index: number): string {
  return PALETTE[index % PALETTE.length] ?? "#7c6cf0";
}

/** Locale-independent grouping — never en-IN style. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function buildColorMap(providers: UsageByProvider[]): Map<string, string> {
  const sorted = [...providers].sort((a, b) => b.tokens - a.tokens || b.usd - a.usd);
  const map = new Map<string, string>();
  sorted.forEach((p, idx) => {
    map.set(p.provider, colorAt(idx));
  });
  return map;
}

export function ProviderBars({
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
