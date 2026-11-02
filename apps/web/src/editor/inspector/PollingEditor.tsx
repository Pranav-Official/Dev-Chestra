import type { AgentCli, PollProbe, StartPollingConfig } from "@devchestra/schema";
import { POLL_PROBE_ID } from "@devchestra/schema";
import { PROBE_NAME_DEFAULT, probeNodeId } from "../poll/probe.js";
import { CheckboxField, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";

/**
 * Edits `start.polling` without duplicating the probe fields: the probe type
 * switch, dedupe, workspace, the output-contract help and an Edit button that
 * selects the derived probe node. The probe itself is edited with the normal
 * Agent/Shell inspector forms. Every control commits a single patch, so each
 * edit is one undo step.
 */
export function PollingEditor({
  nodeId,
  polling,
  paramCount,
  issues,
  onChange,
  onSelectProbe,
}: {
  nodeId: string;
  polling: StartPollingConfig;
  paramCount: number;
  issues: readonly import("@devchestra/schema").Issue[];
  onChange: (next: StartPollingConfig) => void;
  onSelectProbe?: ((probeNodeId: string) => void) | undefined;
}) {
  const { clis } = useAvailableClis();
  const probe = polling.probe;
  const dedupeIssue = fieldIssue(issues, "/polling/dedupe") ?? fieldIssue(issues, "/dedupe");
  const workspaceIssue =
    fieldIssue(issues, "/polling/workspace") ?? fieldIssue(issues, "/workspace");
  const dedupe = polling.dedupe ?? true;
  const workspace = polling.workspace ?? "project";

  const setProbe = (next: PollProbe): void => onChange({ ...polling, probe: next });

  const firstCli = (clis.find((entry) => entry.enabled)?.id ?? "claude-code") as AgentCli;
  const hasWrite = probe.type === "agent" && probe.permissions.write.length > 0;
  const hasMcp = probe.type === "agent" && (probe.mcpServers ?? []).length > 0;
  const showPrivilegeWarning = probe.type === "agent" && (hasWrite || hasMcp);

  return (
    <div className="inspector-stack">
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
                        ? {
                            id: POLL_PROBE_ID,
                            type: "shell",
                            name: PROBE_NAME_DEFAULT,
                            command: "",
                          }
                        : {
                            id: POLL_PROBE_ID,
                            type: "agent",
                            name: PROBE_NAME_DEFAULT,
                            cli: firstCli,
                            prompt: "",
                            permissions: { network: true, write: [], shell: true },
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
      <p className="inspector-help" role="note" data-testid="inspector-polling-unattended">
        The probe runs unattended on every tick.
      </p>
      {showPrivilegeWarning ? (
        <div
          className="inspector-note amber"
          role="note"
          data-testid="inspector-polling-write-warning"
        >
          <div>
            <b>Unattended writes.</b>
            <p>
              This agent probe runs on every tick with{" "}
              {hasWrite && hasMcp
                ? "write access and MCP servers"
                : hasWrite
                  ? "write access"
                  : "MCP servers"}
              . It can change files, branches or remote state without anyone watching.
            </p>
          </div>
        </div>
      ) : null}
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
        <div
          className="inspector-note amber"
          role="note"
          data-testid="inspector-polling-worktree-warning"
        >
          <div>
            <p>A fresh worktree per poll is slow.</p>
          </div>
        </div>
      )}
      <div>
        <button
          type="button"
          className="btn sm"
          data-testid="inspector-polling-edit-probe"
          onClick={() => onSelectProbe?.(probeNodeId(nodeId))}
        >
          Edit probe
        </button>
      </div>
    </div>
  );
}
