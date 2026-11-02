import type { AgentCli, Issue, PollProbe, StartPollingConfig } from "@devchestra/schema";
import type { AgentModelPatch } from "./AgentModelField.js";
import { AgentModelField } from "./AgentModelField.js";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { CheckboxField, describedBy, Field } from "./fields/fields.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";
import { ProviderChips } from "./ProviderChips.js";

function probeIssue(issues: readonly Issue[], suffix: string): string | null {
  return fieldIssue(issues, suffix);
}

/** Sets an optional probe timeout: absent when unset, so the saved file stays minimal. */
function withTimeout<T extends { timeoutMin?: number }>(
  probe: T,
  timeoutMin: number | undefined,
): T {
  const next = { ...probe };
  if (timeoutMin === undefined) delete next.timeoutMin;
  else next.timeoutMin = timeoutMin;
  return next;
}

function probeFailure(issues: readonly Issue[]): string | null {
  const found = issues.filter(
    (issue) => issue.code === "E_POLL_PROBE" && issue.severity === "error",
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

function ProbeTimeout({
  timeoutMin,
  onChange,
  issues,
}: {
  timeoutMin: number | undefined;
  onChange: (value: number | undefined) => void;
  issues: readonly Issue[];
}) {
  const timeout = useBufferedNumber(timeoutMin, {
    label: "Probe timeout",
    min: 1,
    max: 480,
    allowEmpty: true,
    onCommit: onChange,
    bufferKey: "polling.probe.timeoutMin",
  });
  const issue =
    probeIssue(issues, "/polling/probe/timeoutMin") ?? fieldIssue(issues, "/timeoutMin");
  const error = timeout.localError ?? issue;
  const id = "inspector-polling-timeout";
  return (
    <Field
      id={id}
      label="Timeout (minutes)"
      help="Optional. Blank uses the default. Must be shorter than the arming interval."
      error={error}
    >
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="numeric"
        value={timeout.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => timeout.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function ShellProbe({
  nodeId,
  probe,
  issues,
  onChange,
}: {
  nodeId: string;
  probe: Extract<PollProbe, { type: "shell" }>;
  issues: readonly Issue[];
  onChange: (next: Extract<PollProbe, { type: "shell" }>) => void;
}) {
  const commandIssue =
    probeIssue(issues, "/polling/probe/command") ?? fieldIssue(issues, "/command");
  const id = "inspector-polling-command";
  return (
    <div className="inspector-stack">
      <Field
        id={id}
        label="Command"
        required
        help="Runs in the project root on every tick. Print the start parameters as JSON, or nothing."
        error={commandIssue}
      >
        <ExpandableTextarea
          id={id}
          label="Probe command"
          value={probe.command}
          onCommit={(next) => onChange({ ...probe, command: next })}
          mode="none"
          nodeId={nodeId}
          field="polling.command"
          textareaTestId={id}
          rows={5}
          className="inspector-input inspector-textarea inspector-code-input"
          spellCheck={false}
          error={commandIssue}
          help="Runs in the project root on every tick. Print the start parameters as JSON, or nothing."
          describedBy={describedBy(id, undefined, commandIssue)}
        />
      </Field>
      <ProbeTimeout
        timeoutMin={probe.timeoutMin}
        issues={issues}
        onChange={(timeoutMin) => onChange(withTimeout(probe, timeoutMin))}
      />
    </div>
  );
}

function AgentProbe({
  nodeId,
  projectId,
  probe,
  issues,
  onChange,
}: {
  nodeId: string;
  projectId?: string | undefined;
  probe: Extract<PollProbe, { type: "agent" }>;
  issues: readonly Issue[];
  onChange: (next: Extract<PollProbe, { type: "agent" }>) => void;
}) {
  const { clis } = useAvailableClis();
  const cliIssue = probeIssue(issues, "/polling/probe/cli") ?? fieldIssue(issues, "/cli");
  const promptIssue = probeIssue(issues, "/polling/probe/prompt") ?? fieldIssue(issues, "/prompt");
  const id = "inspector-polling-prompt";
  const onModelPatch = (patch: AgentModelPatch): void => {
    const next = { ...probe };
    if (patch.cli !== undefined) next.cli = patch.cli;
    if (patch.model === undefined) delete next.model;
    else next.model = patch.model;
    onChange(next);
  };
  return (
    <div className="inspector-stack">
      <Field id="inspector-polling-cli" label="Provider" error={cliIssue}>
        <ProviderChips
          clis={clis}
          value={probe.cli}
          invalid={cliIssue !== null}
          describedBy={describedBy("inspector-polling-cli", undefined, cliIssue)}
          onSelect={(next) => {
            if (next !== probe.cli) {
              const switched = { ...probe, cli: next };
              delete switched.model;
              onChange(switched);
            }
          }}
        />
      </Field>
      <AgentModelField
        key={`${nodeId}:${probe.cli}`}
        node={{ id: nodeId, cli: probe.cli, model: probe.model }}
        projectId={projectId}
        issues={issues}
        onPatch={onModelPatch}
      />
      <Field
        id={id}
        label="Prompt"
        required
        help="The probe is read-only: it cannot write to the workspace or project. The engine adds the output contract."
        error={promptIssue}
      >
        <ExpandableTextarea
          id={id}
          label="Probe prompt"
          value={probe.prompt}
          onCommit={(next) => onChange({ ...probe, prompt: next })}
          mode="none"
          nodeId={nodeId}
          field="polling.prompt"
          textareaTestId={id}
          rows={5}
          error={promptIssue}
          help="The probe is read-only: it cannot write to the workspace or project. The engine adds the output contract."
          describedBy={describedBy(id, undefined, promptIssue)}
        />
      </Field>
      <ProbeTimeout
        timeoutMin={probe.timeoutMin}
        issues={issues}
        onChange={(timeoutMin) => onChange(withTimeout(probe, timeoutMin))}
      />
      <p className="inspector-help" role="note">
        Each poll spends tokens.
      </p>
    </div>
  );
}

/**
 * Edits `start.polling`: the probe plus dedupe and workspace. Every control
 * commits a single patch, so each edit is one undo step.
 */
export function PollingEditor({
  nodeId,
  projectId,
  polling,
  paramCount,
  issues,
  onChange,
}: {
  nodeId: string;
  projectId?: string | undefined;
  polling: StartPollingConfig;
  paramCount: number;
  issues: readonly Issue[];
  onChange: (next: StartPollingConfig) => void;
}) {
  const { clis } = useAvailableClis();
  const probe = polling.probe;
  const failure = probeFailure(issues);
  const probeError = probeIssue(issues, "/polling/probe") ?? probeIssue(issues, "/polling");
  const dedupeIssue = probeIssue(issues, "/polling/dedupe");
  const workspaceIssue = probeIssue(issues, "/polling/workspace");
  const dedupe = polling.dedupe ?? true;
  const workspace = polling.workspace ?? "project";

  const setProbe = (next: PollProbe): void => onChange({ ...polling, probe: next });

  return (
    <div className="inspector-stack">
      {failure === null && probeError === null ? null : (
        <p className="inspector-error" role="alert" data-testid="inspector-polling-error">
          {failure ?? probeError}
        </p>
      )}
      <Field id="inspector-polling-probe-type" label="Probe type">
        <div
          className="inspector-segmented"
          role="radiogroup"
          aria-label="Probe type"
          id="inspector-polling-probe-type"
        >
          {(["shell", "agent"] as const).map((kind) => (
            <label key={kind} className="inspector-check">
              <input
                type="radio"
                name="polling-probe-type"
                data-testid={`inspector-polling-probe-${kind}`}
                checked={probe.type === kind}
                onChange={() => {
                  if (probe.type !== kind) {
                    setProbe(
                      kind === "shell"
                        ? { type: "shell", command: "" }
                        : {
                            type: "agent",
                            cli: (clis.find((entry) => entry.enabled)?.id ?? "codex") as AgentCli,
                            prompt: "",
                          },
                    );
                  }
                }}
              />
              <span style={{ textTransform: "capitalize" }}>{kind}</span>
            </label>
          ))}
        </div>
      </Field>
      {probe.type === "shell" ? (
        <ShellProbe nodeId={nodeId} probe={probe} issues={issues} onChange={setProbe} />
      ) : (
        <AgentProbe
          nodeId={nodeId}
          projectId={projectId}
          probe={probe}
          issues={issues}
          onChange={setProbe}
        />
      )}
      <p className="inspector-help">
        On each tick the probe decides whether to start a run. Empty output means nothing happens —
        no run starts. Otherwise print a JSON object keyed by the start parameters
        {paramCount === 1
          ? " (this workflow declares exactly one parameter, so a single bare line of output is used as its value)"
          : ""}
        , plus an optional <span className="mono">dedupeKey</span> string, which is removed before
        use.
      </p>
      <CheckboxField
        id="inspector-polling-dedupe"
        label="Skip repeats"
        hint="A result already triggered in the last 7 days is skipped."
        help="The probe can return a dedupeKey to re-trigger on the same item."
        checked={dedupe}
        error={dedupeIssue}
        onChange={(next) => onChange({ ...polling, dedupe: next })}
      />
      <Field id="inspector-polling-workspace" label="Run probe in" error={workspaceIssue}>
        <div
          className="inspector-segmented"
          role="radiogroup"
          aria-label="Run probe in"
          id="inspector-polling-workspace"
        >
          <label className="inspector-check">
            <input
              type="radio"
              name="polling-workspace"
              data-testid="inspector-polling-workspace-project"
              checked={workspace === "project"}
              onChange={() => {
                if (workspace !== "project") onChange({ ...polling, workspace: "project" });
              }}
            />
            <span>Project root</span>
          </label>
          <label className="inspector-check">
            <input
              type="radio"
              name="polling-workspace"
              data-testid="inspector-polling-workspace-worktree"
              checked={workspace === "worktree"}
              onChange={() => {
                if (workspace !== "worktree") onChange({ ...polling, workspace: "worktree" });
              }}
            />
            <span>New worktree each poll</span>
          </label>
        </div>
      </Field>
      {workspace === "project" ? (
        <p className="inspector-help">Read-only, no checkout.</p>
      ) : (
        <p className="inspector-help" role="note">
          A fresh worktree per poll is slow.
        </p>
      )}
    </div>
  );
}
