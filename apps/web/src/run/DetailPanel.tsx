import type { DecisionRef, EventEnvelope, RunView } from "@devchestra/core";
import { Info, LockKeyhole } from "lucide-react";
import { classifyError } from "../api/client.js";
import { useExecutionDetail } from "../api/hooks.js";
import type { AttemptView, ExecutionDetailResponse, RunSummary } from "../api/types.js";
import { DecisionResultView } from "../ui/DecisionResult.js";
import { formatCost, formatDuration, formatTime, formatTokens, shortSha } from "../ui/format.js";
import { JsonView } from "../ui/JsonView.js";
import { StatusPill } from "../ui/StatusPill.js";
import { InlineError } from "../ui/states.js";
import { ApprovalPanel } from "./ApprovalPanel.js";
import { type DerivedAttempt, deriveDetail } from "./deriveDetail.js";
import type { WorkflowSnapshot } from "./RunCanvas.js";

/** Redacted CLI stderr saved on the node error (engine bounds it to 2 KiB). */
function errorDiagnostic(details: unknown): string | null {
  if (details !== null && typeof details === "object") {
    const stderr = (details as Record<string, unknown>).stderr;
    if (typeof stderr === "string") {
      const trimmed = stderr.trim();
      if (trimmed !== "") {
        return trimmed.length <= 2000 ? trimmed : `${trimmed.slice(0, 2000)}…[truncated]`;
      }
    }
  }
  return null;
}

export interface McpToolsSummary {
  shell: boolean | null;
  servers: { name: string; scope: string }[];
}

/** Compact Tools summary from resolved agent input (`tools: { shell, servers }`). Names and scopes only. */
export function extractMcpTools(data: unknown): McpToolsSummary | null {
  if (typeof data !== "object" || data === null) return null;
  const mcp = (data as Record<string, unknown>).tools;
  if (typeof mcp !== "object" || mcp === null) return null;
  const record = mcp as Record<string, unknown>;
  if (record.shell === undefined && !Array.isArray(record.servers)) return null;
  const shell = typeof record.shell === "boolean" ? record.shell : null;
  const servers = (Array.isArray(record.servers) ? record.servers : []).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, scope } = entry as Record<string, unknown>;
    return typeof name === "string" && typeof scope === "string" ? [{ name, scope }] : [];
  });
  return { shell, servers };
}

export function ToolsLine({ data }: { data: unknown }) {
  const tools = extractMcpTools(data);
  if (tools === null) return null;
  return (
    <p className="faint" data-testid="detail-tools" style={{ fontSize: 12 }}>
      Tools: Shell {tools.shell === true ? "on" : tools.shell === false ? "off" : "default"}
      {tools.servers.map((server) => (
        <span key={`${server.scope}:${server.name}`} className="chip" style={{ marginLeft: 6 }}>
          {server.name} · {server.scope}
        </span>
      ))}
    </p>
  );
}

function execFor(view: RunView, path: string): RunView["executions"][string] | undefined {
  const direct = view.executions[path];
  if (direct !== undefined) return direct;
  for (const [key, exec] of Object.entries(view.executions)) {
    if (key.endsWith(`/${path}`)) return exec;
  }
  return undefined;
}

function AttemptList({ attempts }: { attempts: (AttemptView | DerivedAttempt)[] }) {
  if (attempts.length === 0) {
    return <p className="faint">No attempts recorded.</p>;
  }
  return (
    <div>
      {attempts.map((attempt) => {
        const derived = "errors" in attempt ? attempt : null;
        return (
          <div className="attempt" key={`${attempt.attempt}-${attempt.generation}`}>
            <span className="mono faint">#{attempt.attempt}</span>
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                <span>{attempt.mode === "resume" ? "Resumed session" : "Fresh session"}</span>
                {attempt.cli ? <span className="chip">{attempt.cli}</span> : null}
                {attempt.sessionId ? <span className="mono faint">{attempt.sessionId}</span> : null}
                {attempt.stopReason ? (
                  <span className="faint">
                    stopped: {attempt.stopReason}
                    {attempt.exitCode === null ? "" : ` (exit ${attempt.exitCode})`}
                  </span>
                ) : null}
              </div>
              {derived?.errors.map((error) => (
                <div
                  key={`${attempt.attempt}-${attempt.generation}-${error}`}
                  className="faint"
                  style={{ fontSize: 12 }}
                >
                  {error}
                </div>
              ))}
              <div className="faint" style={{ fontSize: 11.5 }}>
                generation {attempt.generation}
                {attempt.startedAt ? ` · ${formatTime(attempt.startedAt)}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReplayDetail({
  events,
  path,
  view,
}: {
  events: EventEnvelope[];
  path: string;
  view: RunView;
}) {
  const derived = deriveDetail(events, path, view.lastEventId);
  return (
    <>
      <div className="note accent" data-testid="replay-detail-unavailable">
        <LockKeyhole size={15} aria-hidden="true" />
        <span>
          Latest execution details, transcripts and process data are unavailable in replay. Facts
          below are derived from events up to #{view.lastEventId}.
        </span>
      </div>
      <h3 style={{ margin: "14px 0 6px" }}>Attempts</h3>
      <AttemptList attempts={derived.attempts} />
      <h3 style={{ margin: "14px 0 6px" }}>Input</h3>
      {derived.input === null ? (
        <p className="faint">Input content is not present in the event log for this attempt.</p>
      ) : (
        <>
          <div className="mono faint" style={{ marginBottom: 4 }}>
            hash {derived.input.inputsHash || "—"} · event #{derived.input.eventId}
          </div>
          {derived.input.inputs === null ? (
            <p className="faint">The event recorded an input hash but not the input value.</p>
          ) : (
            <>
              <ToolsLine data={derived.input.inputs} />
              <JsonView value={derived.input.inputs} testId="detail-output" />
            </>
          )}
        </>
      )}
      <h3 style={{ margin: "14px 0 6px" }}>Output</h3>
      {derived.output === null ? (
        <p className="faint">No output event yet at this position.</p>
      ) : (
        <div className="note" data-testid="detail-output">
          <Info size={15} aria-hidden="true" />
          <span>
            Output content is unavailable in replay. Recorded output{" "}
            <span className="mono">{derived.output.outputId || "—"}</span>, hash{" "}
            <span className="mono">{derived.output.outputHash || "—"}</span>. Validated at event{" "}
            {derived.output.validatedEventId ?? "—"}, recorded at{" "}
            {derived.output.recordedEventId ?? "—"}.
          </span>
        </div>
      )}
      {derived.process ? (
        <>
          <h3 style={{ margin: "14px 0 6px" }}>Process</h3>
          <dl className="kv">
            <dt>PID</dt>
            <dd className="mono">{derived.process.pid}</dd>
            <dt>Binary</dt>
            <dd className="mono">{derived.process.binary}</dd>
            <dt>CWD</dt>
            <dd className="mono">{derived.process.cwd}</dd>
            <dt>Started</dt>
            <dd>{formatTime(derived.process.startedAt)}</dd>
            <dt>Stopped</dt>
            <dd>{derived.process.stoppedAt ? formatTime(derived.process.stoppedAt) : "—"}</dd>
          </dl>
        </>
      ) : null}
      {derived.workspace ? (
        <>
          <h3 style={{ margin: "14px 0 6px" }}>Workspace</h3>
          <dl className="kv">
            <dt>Mode</dt>
            <dd>{derived.workspace.mode ?? "—"}</dd>
            <dt>Directory</dt>
            <dd className="mono">{derived.workspace.dir}</dd>
            <dt>Branch</dt>
            <dd className="mono">{derived.workspace.branch ?? "—"}</dd>
            <dt>Commit</dt>
            <dd className="mono">{shortSha(derived.workspace.commitSha)}</dd>
          </dl>
        </>
      ) : null}
      <h3 style={{ margin: "14px 0 6px" }}>Provenance</h3>
      <dl className="kv">
        <dt>As of event</dt>
        <dd className="mono">#{view.lastEventId}</dd>
        <dt>Status history</dt>
        <dd>
          {derived.statusEvents.length === 0
            ? "—"
            : derived.statusEvents
                .map((item) => `${item.from} → ${item.to} (#${item.eventId})`)
                .join(", ")}
        </dd>
      </dl>
    </>
  );
}

function DecisionSection({
  decision,
  tokensIn,
  tokensOut,
}: {
  decision: DecisionRef;
  tokensIn: number;
  tokensOut: number;
}) {
  return (
    <>
      <h3 style={{ margin: "14px 0 6px" }}>Decision</h3>
      <DecisionResultView
        output={decision.output}
        routing={decision.routing}
        usage={{ inputTokens: tokensIn, outputTokens: tokensOut }}
        testIdPrefix="detail-decision"
      />
    </>
  );
}

function LiveDetail({ data, path }: { data: ExecutionDetailResponse; path: string }) {
  const { execution, attempts, input, output, usage, process, workspace } = data;
  return (
    <>
      <dl className="kv" style={{ marginBottom: 14 }}>
        <dt>Status</dt>
        <dd>
          <StatusPill status={execution.status} />
        </dd>
        <dt>Kind</dt>
        <dd>{execution.kind ?? "—"}</dd>
        <dt>Attempt</dt>
        <dd>
          {execution.attempt} · generation {execution.generation}
        </dd>
        <dt>CLI</dt>
        <dd>{execution.cli ?? "—"}</dd>
        <dt>Model</dt>
        <dd>{execution.model ?? "—"}</dd>
        <dt>Validation</dt>
        <dd>
          {execution.validationAttempts} of {execution.validationLimit}
          {execution.crashAttempts > 0 ? ` · ${execution.crashAttempts} crash retries` : ""}
        </dd>
        <dt>Started</dt>
        <dd>{formatTime(execution.startedAt)}</dd>
        <dt>Ended</dt>
        <dd>{formatTime(execution.endedAt)}</dd>
        <dt>Usage</dt>
        <dd>
          {formatTokens(usage.tokensIn)} in · {formatTokens(usage.tokensOut)} out ·{" "}
          {formatCost(usage.costUsd)} ({usage.costSource})
        </dd>
        <dt>Last event</dt>
        <dd className="mono">#{execution.lastEventId}</dd>
      </dl>
      {execution.errorMessage ? (
        <InlineError message={`${execution.errorCode ?? "Error"}: ${execution.errorMessage}`} />
      ) : null}
      <h3 style={{ margin: "14px 0 6px" }}>Attempts</h3>
      <AttemptList attempts={attempts} />
      <h3 style={{ margin: "14px 0 6px" }}>Input</h3>
      {input === null ? (
        <p className="faint">No resolved input is available for this execution.</p>
      ) : (
        <>
          <div className="mono faint" style={{ marginBottom: 4 }}>
            hash {input.hash || "—"} · {input.bytes} bytes
            {input.truncated ? " · preview truncated" : ""}
          </div>
          {input.data === null ? (
            <p className="faint">Input content was not inlined (over 64 KiB).</p>
          ) : (
            <>
              <ToolsLine data={input.data} />
              <JsonView value={input.data} testId="detail-input" />
            </>
          )}
        </>
      )}
      <h3 style={{ margin: "14px 0 6px" }}>Output</h3>
      {output === null ? (
        <p className="faint">No accepted output yet.</p>
      ) : (
        <>
          <div className="mono faint" style={{ marginBottom: 4 }}>
            id {output.id || "—"} · hash {output.hash || "—"} · {output.bytes} bytes
            {output.truncated ? " · preview truncated" : ""}
          </div>
          {output.data === null ? (
            <p className="faint">Output content was not inlined (over 64 KiB).</p>
          ) : (
            <JsonView value={output.data} testId="detail-output" />
          )}
        </>
      )}
      {process ? (
        <>
          <h3 style={{ margin: "14px 0 6px" }}>Process</h3>
          <dl className="kv">
            <dt>PID</dt>
            <dd className="mono">{process.pid}</dd>
            <dt>Binary</dt>
            <dd className="mono">{process.binary}</dd>
            <dt>CWD</dt>
            <dd className="mono">{process.cwd}</dd>
            <dt>Started</dt>
            <dd>{formatTime(process.startedAt)}</dd>
            <dt>Stopped</dt>
            <dd>
              {process.stoppedAt === null ? "—" : formatTime(process.stoppedAt)}
              {process.stopReason ? ` · ${process.stopReason}` : ""}
              {process.exitCode === null ? "" : ` · exit ${process.exitCode}`}
            </dd>
          </dl>
        </>
      ) : null}
      {workspace ? (
        <>
          <h3 style={{ margin: "14px 0 6px" }}>Workspace</h3>
          <dl className="kv">
            <dt>Directory</dt>
            <dd className="mono">{workspace.dir || "—"}</dd>
            <dt>Branch</dt>
            <dd className="mono">{workspace.branch ?? "—"}</dd>
            <dt>Base</dt>
            <dd className="mono">{shortSha(workspace.baseSha)}</dd>
            <dt>Commit</dt>
            <dd className="mono">{shortSha(workspace.commitSha)}</dd>
            <dt>Changes</dt>
            <dd>
              {workspace.filesChanged === null
                ? "—"
                : `${workspace.filesChanged} files, +${workspace.insertions ?? 0} −${workspace.deletions ?? 0}`}
            </dd>
          </dl>
        </>
      ) : null}
      <h3 style={{ margin: "14px 0 6px" }}>Provenance</h3>
      <dl className="kv">
        <dt>Path</dt>
        <dd className="mono">{path}</dd>
        <dt>Session</dt>
        <dd className="mono">{execution.sessionId ?? "—"}</dd>
        <dt>Session CWD</dt>
        <dd className="mono">{execution.sessionCwd ?? "—"}</dd>
        <dt>Input hash</dt>
        <dd className="mono">{input?.hash ?? "—"}</dd>
        <dt>Output id</dt>
        <dd className="mono">{execution.outputId ?? "—"}</dd>
      </dl>
    </>
  );
}

export function RunSummaryPanel({
  run,
  view,
  isReplay,
}: {
  run: RunSummary | null;
  view: RunView;
  isReplay: boolean;
}) {
  return (
    <>
      {isReplay ? (
        <div className="note accent" data-testid="replay-detail-unavailable">
          <LockKeyhole size={15} aria-hidden="true" />
          <span>
            Viewing the run at event #{view.lastEventId}. Latest run details and results are not
            shown here.
          </span>
        </div>
      ) : null}
      <dl className="kv" style={{ marginTop: isReplay ? 12 : 0 }}>
        <dt>Status</dt>
        <dd>
          <StatusPill status={view.status} />
        </dd>
        <dt>Run</dt>
        <dd>#{run?.runNumber ?? view.runNumber}</dd>
        <dt>Workflow</dt>
        <dd>{run?.workflowName ?? run?.workflowId ?? "—"}</dd>
        <dt>Kind</dt>
        <dd>{run?.kind ?? "run"}</dd>
        <dt>Created</dt>
        <dd>{formatTime(run?.createdAt)}</dd>
        <dt>Active</dt>
        <dd>{formatDuration(view.budget.activeMs)}</dd>
        <dt>Paused</dt>
        <dd>
          {formatDuration(view.pausedMs)}
          {view.pauseReason ? ` · ${view.pauseReason}` : ""}
        </dd>
        <dt>Cost</dt>
        <dd>{formatCost(view.budget.usd)}</dd>
        <dt>Tokens</dt>
        <dd>{formatTokens(view.budget.tokens)}</dd>
        <dt>Last event</dt>
        <dd className="mono">#{view.lastEventId}</dd>
      </dl>
      {view.pauseDetail ? (
        <div className="note amber" style={{ marginTop: 12 }}>
          <Info size={15} aria-hidden="true" />
          <span>{view.pauseDetail}</span>
        </div>
      ) : null}
      {view.errors.length > 0 ? (
        <>
          <h3 style={{ margin: "14px 0 6px" }}>Errors</h3>
          <div className="col">
            {view.errors.slice(-5).map((error) => {
              const diagnostic = errorDiagnostic(error.details);
              return (
                <div key={error.eventId} className="note red">
                  <span className="mono">#{error.eventId}</span>
                  <span>
                    {error.code}: {error.message}
                  </span>
                  {diagnostic === null ? null : (
                    <pre
                      className="mono"
                      data-testid="run-error-stderr"
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        margin: "4px 0 0",
                        fontSize: 12,
                      }}
                    >
                      {diagnostic}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="note" style={{ marginTop: 14 }}>
        <Info size={15} aria-hidden="true" />
        <span>Select a node to inspect attempts, input, output, workspace and provenance.</span>
      </div>
    </>
  );
}

export function DetailPanel({
  run,
  runId,
  path,
  nodeLabel,
  view,
  events,
  isReplay,
  snapshot,
}: {
  run: RunSummary | null;
  runId: string;
  path: string | null;
  nodeLabel: string | null;
  view: RunView;
  events: EventEnvelope[];
  isReplay: boolean;
  snapshot?: WorkflowSnapshot | null;
}) {
  const execution = useExecutionDetail(runId, path, !isReplay && path !== null);
  if (path === null) {
    return <RunSummaryPanel run={run} view={view} isReplay={isReplay} />;
  }
  const exec = execFor(view, path);
  const status = exec?.status ?? "pending";
  const snapshotNode = snapshot?.graph.nodes.find((n) => n.id === path) ?? null;
  const isApproval =
    exec?.kind === "approval" || snapshotNode?.type === "approval" || status === "waiting_approval";
  if (isApproval && snapshot) {
    return (
      <>
        <div className="panel-title">
          <div className="grow">
            <div className="name">{nodeLabel ?? exec?.nodeId ?? path}</div>
            <div className="faint mono" style={{ fontSize: 11.5 }}>
              {path}
            </div>
          </div>
          <StatusPill status={status} testId="detail-status" />
        </div>
        <ApprovalPanel
          runId={runId}
          path={path}
          snapshot={snapshot}
          view={view}
          isReplay={isReplay}
        />
        {/* Keep provenance below decision for audit */}
        {isReplay ? (
          <ReplayDetail events={events} path={path} view={view} />
        ) : execution.data ? (
          <LiveDetail data={execution.data} path={path} />
        ) : null}
      </>
    );
  }
  return (
    <>
      <div className="panel-title">
        <div className="grow">
          <div className="name">{nodeLabel ?? exec?.nodeId ?? path}</div>
          <div className="faint mono" style={{ fontSize: 11.5 }}>
            {path}
          </div>
        </div>
        <StatusPill status={status} testId="detail-status" />
      </div>
      {exec?.decision ? (
        <DecisionSection
          decision={exec.decision}
          tokensIn={exec.tokensIn}
          tokensOut={exec.tokensOut}
        />
      ) : null}
      {isReplay ? (
        <ReplayDetail events={events} path={path} view={view} />
      ) : execution.isPending ? (
        <div className="col" aria-busy="true">
          <div className="skeleton" style={{ width: "70%" }} />
          <div className="skeleton" style={{ width: "100%" }} />
          <div className="skeleton" style={{ width: "84%" }} />
        </div>
      ) : execution.error ? (
        <InlineError message={classifyError(execution.error).message} />
      ) : execution.data ? (
        <LiveDetail data={execution.data} path={path} />
      ) : null}
    </>
  );
}
