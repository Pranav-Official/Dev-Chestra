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

const DONUT_COLORS = ["#7c6cf0", "#4cc38a", "#f0a35e"];

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
  const max = Math.max(1, ...providers.map((p) => p.tokens));
  const width = 320;
  const height = 140;
  const barWidth = 28;
  const gap = (width - barWidth * Math.max(providers.length, 1)) / (Math.max(providers.length, 1) + 1);
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Tokens per provider bar chart"
    >
      {providers.map((item, index) => {
        const barHeight = Math.max(4, Math.round((item.tokens / max) * (height - 32)));
        const x = gap + index * (barWidth + gap);
        const y = height - 20 - barHeight;
        return (
          <g key={item.provider}>
            <rect x={x} y={y} width={barWidth} height={barHeight} rx={4} fill="#7c6cf0" />
            <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" fontSize={10} fill="currentColor">
              {formatTokens(item.tokens)}
            </text>
            <text
              x={x + barWidth / 2}
              y={height - 6}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor"
              opacity={0.7}
            >
              {item.provider}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function CostDonut({ providers }: { providers: UsageByProvider[] }) {
  const models = providers.flatMap((p) =>
    p.byModel.map((m) => ({ ...m, label: `${p.provider} / ${m.model}` })),
  );
  const total = models.reduce((sum, item) => sum + item.usd, 0);
  if (total <= 0) return <p className="faint">No cost data yet.</p>;
  let cursor = 0;
  const segments = models.map((item, index) => {
    const start = (cursor / total) * 100;
    cursor += item.usd;
    const end = (cursor / total) * 100;
    const color = DONUT_COLORS[index % DONUT_COLORS.length];
    return `${color} ${start.toFixed(1)}% ${end.toFixed(1)}%`;
  });
  return (
    <div className="row wrap" style={{ gap: 16, alignItems: "center" }}>
      <div
        role="img"
        aria-label="Cost by model donut chart"
        style={{
          width: 140,
          height: 140,
          borderRadius: "50%",
          flex: "none",
          background: `conic-gradient(${segments.join(", ")})`,
          mask: "radial-gradient(circle, transparent 52%, black 53%)",
          WebkitMask: "radial-gradient(circle, transparent 52%, black 53%)",
        }}
      />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {models.map((item, index) => (
          <li key={item.label} className="row" style={{ gap: 8, alignItems: "center" }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: DONUT_COLORS[index % DONUT_COLORS.length],
              }}
            />
            <span className="mono">{item.label}</span>
            <span className="faint">
              {formatCost(item.usd)} · {formatTokens(item.tokens)} tokens
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
          <div className="v">{data.total.tokens.toLocaleString()}</div>
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
