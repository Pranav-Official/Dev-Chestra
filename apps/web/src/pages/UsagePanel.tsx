import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { formatCost, formatTokens } from "../ui/format.js";

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

/** Fallback shown when the live `/api/usage` endpoint is unreachable. */
export const MOCK_USAGE: UsageSummary = {
  total: { usd: 18.42, tokens: 4_820_500 },
  byProvider: [
    {
      provider: "claude",
      usd: 18.42,
      tokens: 4_820_500,
      byModel: [
        { model: "claude-sonnet", usd: 11.2, tokens: 2_910_000 },
        { model: "claude-opus", usd: 5.9, tokens: 1_420_500 },
        { model: "claude-haiku", usd: 1.32, tokens: 490_000 },
      ],
    },
  ],
};

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
  const url =
    projectId === undefined ? "/api/usage" : `/api/usage?scope=project&projectId=${projectId}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Usage request failed (${response.status})`);
  return (await response.json()) as UsageSummary;
}

function ProviderBars({ providers }: { providers: UsageByProvider[] }) {
  const rows = [...providers].sort((a, b) => b.tokens - a.tokens);
  const max = Math.max(1, ...rows.map((p) => p.tokens));
  if (rows.length === 0) return <p className="faint">No provider data yet.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
      {rows.map((item, index) => (
        <li
          key={item.provider}
          style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 10, alignItems: "center" }}
        >
          <span
            className="mono"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={item.provider}
          >
            {item.provider}
          </span>
          <span
            role="img"
            aria-label={`${item.provider}: ${formatCount(item.tokens)} tokens`}
            style={{
              display: "block",
              height: 18,
              borderRadius: 5,
              background: "var(--bg-muted)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${Math.max(2, (item.tokens / max) * 100)}%`,
                borderRadius: 5,
                background: colorAt(index),
              }}
            />
          </span>
          <span className="faint mono" style={{ minWidth: 120, textAlign: "right" }}>
            {formatTokens(item.tokens)} · {formatCost(item.usd)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CostDonut({ providers }: { providers: UsageByProvider[] }) {
  const models = providers
    .flatMap((p) => p.byModel.map((m) => ({ ...m, provider: p.provider })))
    .filter((m) => m.usd > 0 || m.tokens > 0)
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  const total = models.reduce((sum, item) => sum + item.usd, 0);
  if (models.length === 0 || total <= 0) return <p className="faint">No cost data yet.</p>;
  let cursor = 0;
  const segments = models.map((item, index) => {
    const start = (cursor / total) * 100;
    cursor += item.usd;
    const end = (cursor / total) * 100;
    return `${colorAt(index)} ${start.toFixed(1)}% ${end.toFixed(1)}%`;
  });
  return (
    <div className="row wrap" style={{ gap: 20, alignItems: "center" }}>
      <div
        role="img"
        aria-label="Cost by model donut chart"
        style={{
          width: 150,
          height: 150,
          borderRadius: "50%",
          flex: "none",
          background: `conic-gradient(${segments.join(", ")})`,
          mask: "radial-gradient(circle, transparent 55%, black 56%)",
          WebkitMask: "radial-gradient(circle, transparent 55%, black 56%)",
        }}
      />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, flex: "1 1 220px" }}>
        {models.map((item, index) => (
          <li key={`${item.provider}/${item.model}`} className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                flex: "none",
                alignSelf: "center",
                background: colorAt(index),
              }}
            />
            <span className="mono">{shortModel(item.provider, item.model)}</span>
            <span className="faint" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
              {formatCost(item.usd)} · {((item.usd / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UsagePanel() {
  const { pid } = useParams();
  const projectId = pid !== "" && pid !== undefined ? pid : undefined;
  const usage = useQuery({
    queryKey: ["usage", projectId ?? "global"],
    queryFn: ({ signal }) => fetchUsageSummary(projectId, { signal }),
    staleTime: 30_000,
    retry: false,
  });
  // Fall back to mock totals when the live endpoint is unreachable.
  const data = usage.data ?? MOCK_USAGE;
  const mocked = usage.isError || usage.data === undefined;

  return (
    <div>
      {mocked ? (
        <p className="faint" role="status" style={{ marginTop: 0 }}>
          Showing fallback totals — the live <span className="mono">/api/usage</span> endpoint is not
          reachable.
        </p>
      ) : null}
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="faint">Total tokens</div>
          <div className="v">{formatCount(data.total.tokens)}</div>
        </div>
        <div className="stat">
          <div className="faint">Total cost</div>
          <div className="v">{formatCost(data.total.usd)}</div>
        </div>
        <div className="stat">
          <div className="faint">Providers</div>
          <div className="v">{data.byProvider.length}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Tokens by provider</h2>
        <ProviderBars providers={data.byProvider} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Cost by model</h2>
        <CostDonut providers={data.byProvider} />
      </div>
    </div>
  );
}
