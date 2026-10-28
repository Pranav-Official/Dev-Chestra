import type { DecisionRoutingReason } from "@devchestra/core";

/**
 * Structural view over a normalized decision answer. Both the core ExecView
 * projection and the API test result assign to this shape.
 */
export interface DecisionResultOutput {
  kind: "boolean" | "choice" | "score";
  value: boolean | string | null;
  probability?: number | undefined;
  score?: number | undefined;
  probabilities?: Record<string, number> | undefined;
  confidence: number | null;
  confidenceSource: "provider" | "derived" | null;
  refusal?: { reason?: string | undefined } | undefined;
  model: string;
}

function percent(probability: number): string {
  if (!Number.isFinite(probability)) return "—";
  return `${(probability * 100).toFixed(1)}%`;
}

function ProbabilityBar({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div className="decision-bar" data-testid={testId}>
      <span className="decision-bar-label mono">{label}</span>
      <span
        className="decision-bar-track"
        role="img"
        aria-label={`${label} ${percent(value)}`}
        title={`${label}: ${percent(value)}`}
      >
        <span className="decision-bar-fill" style={{ width: `${(clamped * 100).toFixed(1)}%` }} />
      </span>
      <span className="decision-bar-value mono">{percent(value)}</span>
    </div>
  );
}

function valueText(output: DecisionResultOutput): string {
  if (output.refusal !== undefined || output.value === null) return "Refused";
  if (output.kind === "boolean") return output.value === true ? "Yes" : "No";
  return String(output.value);
}

/** Normalized decision answer shared by the tester and the run viewer. */
export function DecisionResultView({
  output,
  routing,
  latencyMs,
  usage,
  testIdPrefix,
}: {
  output: DecisionResultOutput;
  routing: { branch: string | null; reason: DecisionRoutingReason };
  latencyMs?: number | undefined;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
  testIdPrefix: string;
}) {
  const refused = output.refusal !== undefined || output.value === null;
  const probabilities = output.probabilities ?? {};
  const names = Object.keys(probabilities).sort();
  return (
    <div className="inspector-stack" data-testid={`${testIdPrefix}-output`}>
      <dl className="kv">
        <dt>Value</dt>
        <dd data-testid={`${testIdPrefix}-value`}>
          <b>{valueText(output)}</b>
          {output.kind === "boolean" && typeof output.probability === "number" && !refused ? (
            <span className="faint"> · P(yes) {percent(output.probability)}</span>
          ) : null}
          {output.kind === "score" && typeof output.score === "number" && !refused ? (
            <span className="faint"> · score {output.score}</span>
          ) : null}
        </dd>
        <dt>Branch</dt>
        <dd data-testid={`${testIdPrefix}-route`}>
          <span className="mono">{routing.branch ?? "—"}</span>
          <span className="faint"> · {routing.reason}</span>
        </dd>
        <dt>Confidence</dt>
        <dd data-testid={`${testIdPrefix}-confidence`}>
          {output.confidence === null || output.confidenceSource === null ? (
            "—"
          ) : (
            <>
              {percent(output.confidence)}
              <span className="faint"> · {output.confidenceSource}</span>
            </>
          )}
        </dd>
        <dt>Model</dt>
        <dd className="mono" data-testid={`${testIdPrefix}-model`}>
          {output.model || "—"}
        </dd>
        {latencyMs === undefined ? null : (
          <>
            <dt>Latency</dt>
            <dd data-testid={`${testIdPrefix}-latency`}>{latencyMs} ms</dd>
          </>
        )}
        {usage === undefined ? null : (
          <>
            <dt>Usage</dt>
            <dd className="mono" data-testid={`${testIdPrefix}-usage`}>
              {usage.inputTokens} in · {usage.outputTokens} out
            </dd>
          </>
        )}
      </dl>
      {output.refusal?.reason ? (
        <p className="inspector-help" data-testid={`${testIdPrefix}-refusal`}>
          Refused: {output.refusal.reason}
        </p>
      ) : null}
      {names.length > 0 ? (
        <div data-testid={`${testIdPrefix}-probabilities`}>
          {names.map((name) => (
            <ProbabilityBar
              key={name}
              label={name}
              value={probabilities[name] ?? 0}
              testId={`${testIdPrefix}-prob-${name}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
