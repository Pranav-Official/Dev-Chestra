import { useId, useState } from "react";
import "../../styles/usage.css";
import { formatCost, formatTokens } from "../../ui/format.js";
import { colorAt, ProviderBars, type UsageByProject } from "./shared.js";

type Metric = "usd" | "tokens";

const SIZE = 148;
const STROKE = 31;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SLICE_GAP = 1.5;

function formatMetric(metric: Metric, value: number): string {
  return metric === "usd" ? formatCost(value) : `${formatTokens(value)} tok`;
}

function percent(share: number): string {
  return share >= 0.1 || share === 0 ? share.toFixed(1) : "<0.1";
}

interface Slice {
  id: string;
  name: string;
  value: number;
  color: string;
}

function Donut({
  slices,
  total,
  metric,
  selected,
  onSelect,
}: {
  slices: Slice[];
  total: number;
  metric: Metric;
  selected: Slice | undefined;
  onSelect: (id: string) => void;
}) {
  let offset = 0;
  return (
    <div
      style={{
        position: "relative",
        width: SIZE,
        height: SIZE,
        display: "grid",
        placeItems: "center",
        flex: "none",
        margin: "0 auto",
      }}
    >
      <svg
        role="img"
        aria-label="Usage by project donut chart"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {slices.map((slice) => {
            const length = (slice.value / total) * CIRCUMFERENCE;
            const visible = Math.max(0, length - (slices.length > 1 ? SLICE_GAP : 0));
            const start = offset;
            offset += length;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; keyboard and screen-reader users select a project with the legend buttons, which do the same thing
              <circle
                key={slice.id}
                className={`usage-slice${selected !== undefined && selected.id !== slice.id ? " dim" : ""}`}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={slice.color}
                strokeWidth={STROKE}
                strokeDasharray={`${visible} ${CIRCUMFERENCE - visible}`}
                strokeDashoffset={-start}
                onClick={() => onSelect(slice.id)}
              >
                <title>{`${slice.name}: ${formatMetric(metric, slice.value)}`}</title>
              </circle>
            );
          })}
        </g>
      </svg>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          textAlign: "center",
          pointerEvents: "none",
          lineHeight: 1.2,
          maxWidth: 84,
        }}
      >
        <div
          className="faint"
          style={{
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected === undefined ? "Total" : selected.name}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.015em" }}>
          {formatMetric(metric, selected === undefined ? total : selected.value)}
        </div>
      </div>
    </div>
  );
}

/**
 * Spend split by project. Pick a project (a row or its slice) to see how its own
 * spend divides across providers; pick it again, or Clear, to go back to the overview.
 */
export function ProjectUsage({
  projects,
  colorMap,
}: {
  projects: UsageByProject[];
  colorMap: Map<string, string>;
}) {
  const [metric, setMetric] = useState<Metric>("usd");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = useId();

  // Projects with no activity would only be empty rows.
  const active = projects.filter((project) => project.usd > 0 || project.tokens > 0);
  // Colors follow spend order, so a project keeps its color when the metric changes.
  const colors = new Map(
    [...active]
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
      .map((project, index) => [project.projectId, colorAt(index)] as const),
  );
  const ordered = [...active].sort(
    (a, b) => b[metric] - a[metric] || b.tokens - a.tokens || b.usd - a.usd,
  );
  const other: Metric = metric === "usd" ? "tokens" : "usd";
  const total = ordered.reduce((sum, project) => sum + project[metric], 0);
  const slices: Slice[] = ordered
    .filter((project) => project[metric] > 0)
    .map((project) => ({
      id: project.projectId,
      name: project.name,
      value: project[metric],
      color: colors.get(project.projectId) ?? colorAt(0),
    }));
  const selectedProject = ordered.find((project) => project.projectId === selectedId);
  const selectedSlice = slices.find((slice) => slice.id === selectedId);
  const toggle = (id: string) => setSelectedId((current) => (current === id ? null : id));
  const detailProviders = selectedProject?.byProvider.filter((p) => p.usd > 0 || p.tokens > 0);

  return (
    <div className="card">
      <div className="card-head" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Usage by project</h2>
        <fieldset className="usage-metric" aria-label="Chart metric">
          {(
            [
              ["usd", "Cost"],
              ["tokens", "Tokens"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`chip${metric === value ? " on" : ""}`}
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="card-body" style={{ padding: "18px" }}>
        {ordered.length === 0 ? (
          <p className="faint">No project usage yet.</p>
        ) : (
          <>
            <div className="row wrap" style={{ gap: 28, alignItems: "center" }}>
              {total > 0 ? (
                <Donut
                  slices={slices}
                  total={total}
                  metric={metric}
                  selected={selectedSlice}
                  onSelect={toggle}
                />
              ) : (
                <p className="faint" style={{ flex: "none", margin: "0 auto", width: SIZE }}>
                  No {metric === "usd" ? "cost" : "token"} data yet.
                </p>
              )}
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "grid",
                  gap: 2,
                  flex: "1 1 260px",
                }}
              >
                {ordered.map((project) => {
                  const share = total > 0 ? (project[metric] / total) * 100 : 0;
                  return (
                    <li key={project.projectId}>
                      <button
                        type="button"
                        className="usage-project-row"
                        aria-pressed={project.projectId === selectedId}
                        aria-controls={selectedProject === undefined ? undefined : detailId}
                        onClick={() => toggle(project.projectId)}
                      >
                        <span className="row" style={{ gap: 8, minWidth: 0 }}>
                          <span
                            aria-hidden="true"
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 3,
                              flex: "none",
                              background: colors.get(project.projectId),
                            }}
                          />
                          <span
                            style={{
                              fontWeight: 500,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={project.name}
                          >
                            {project.name}
                          </span>
                          {project.removed ? (
                            <span className="faint" style={{ fontSize: 11 }}>
                              removed
                            </span>
                          ) : null}
                        </span>
                        <span
                          className="faint mono usage-project-secondary"
                          style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}
                        >
                          {formatMetric(metric === "usd" ? "tokens" : "usd", project[other])}
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
                          <span style={{ fontWeight: 500 }}>
                            {formatMetric(metric, project[metric])}
                          </span>{" "}
                          <span className="faint">· {percent(share)}%</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            {selectedProject === undefined ? null : (
              <section
                id={detailId}
                className="usage-project-detail"
                aria-label={`Provider split for ${selectedProject.name}`}
              >
                <div>
                  <div
                    className="row"
                    style={{ justifyContent: "space-between", marginBottom: 14, gap: 12 }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ margin: 0, fontSize: 13 }}>
                        {selectedProject.name} · providers
                      </h3>
                      <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                        {formatTokens(selectedProject.tokens)} tokens ·{" "}
                        {formatCost(selectedProject.usd)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setSelectedId(null)}
                    >
                      Clear
                    </button>
                  </div>
                  <ProviderBars providers={detailProviders ?? []} colorMap={colorMap} />
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
