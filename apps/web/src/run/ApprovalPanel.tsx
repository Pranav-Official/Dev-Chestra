import type { RunView } from "@devchestra/core";
import { useState } from "react";
import { resolveApproval } from "../api/approvals.js";
import { classifyError } from "../api/client.js";
import { useExecutionDetail } from "../api/hooks.js";
import { JsonView } from "../ui/JsonView.js";
import { approvalForPath, isActionable } from "./approval.js";
import type { WorkflowSnapshot } from "./RunCanvas.js";

function UpstreamOutputs({
  path,
  snapshot,
  runId,
  isReplay,
}: {
  path: string;
  snapshot: WorkflowSnapshot;
  runId: string;
  isReplay: boolean;
}) {
  const ancestors = (() => {
    const incoming = new Map<string, string[]>();
    for (const edge of snapshot.graph.edges) {
      const src = edge.from.split(".")[0] ?? edge.from;
      const tgt = edge.to.split(".")[0] ?? edge.to;
      const list = incoming.get(tgt);
      if (list === undefined) incoming.set(tgt, [src]);
      else list.push(src);
    }
    const seen = new Set<string>();
    const queue = [path];
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      for (const src of incoming.get(id) ?? []) {
        if (seen.has(src)) continue;
        seen.add(src);
        order.push(src);
        queue.push(src);
      }
    }
    return snapshot.graph.nodes.filter((n) => seen.has(n.id));
  })();

  if (ancestors.length === 0)
    return <p className="faint">No upstream outputs in this workflow snapshot.</p>;

  if (isReplay) {
    return (
      <div className="note amber" data-testid="upstream-replay-note">
        Replay view — upstream outputs are live previews and may not match this historical position.
        <div className="col" style={{ gap: 8, marginTop: 8 }}>
          {ancestors.map((node) => (
            <div key={node.id} className="faint mono" data-testid={`upstream-${node.id}`}>
              {node.id} · {node.name} ({node.type}) — preview hidden in replay
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      {ancestors.map((node) => (
        <UpstreamRow key={node.id} node={node} runId={runId} />
      ))}
    </div>
  );
}

function UpstreamRow({
  node,
  runId,
}: {
  node: { id: string; name: string; type: string };
  runId: string;
}) {
  const detail = useExecutionDetail(runId, node.id, true);
  const output = detail.data?.output ?? null;
  return (
    <div className="note" data-testid={`upstream-${node.id}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className="mono">{node.id}</span>
        <span className="faint">{node.name}</span>
        <span className="chip">{node.type}</span>
      </div>
      {detail.isPending ? <span className="faint">Loading output…</span> : null}
      {output === null ? <span className="faint">No accepted output yet.</span> : null}
      {output && output.data !== null ? (
        <JsonView value={output.data} testId={`upstream-output-${node.id}`} />
      ) : null}
      {output && output.data === null ? (
        <span className="faint">Output over 64 KiB or not inlined.</span>
      ) : null}
    </div>
  );
}

export function ApprovalPanel({
  runId,
  path,
  snapshot,
  view,
  isReplay,
}: {
  runId: string;
  path: string;
  snapshot: WorkflowSnapshot;
  view: RunView;
  isReplay: boolean;
}) {
  const derived = approvalForPath(view, path);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (derived === null || derived.frozen === null) {
    const exec = view.executions[path];
    if (exec?.status === "waiting_approval") {
      return (
        <p className="faint" data-testid="approval-no-identity">
          Approval is waiting but no durable request identity is available for this generation
          (legacy event). This approval is read-only — retry the node to obtain a resolvable
          request.
        </p>
      );
    }
    return <p className="faint">No approval request recorded for this node at this view.</p>;
  }

  const { frozen, resolved, pending } = derived;
  const execStatus = view.executions[path]?.status ?? null;
  const runStatus = view.status;
  const canAct = isActionable(frozen, execStatus, runStatus, isReplay, busy, done) && pending;

  const act = async (decision: "approve" | "reject") => {
    if (!canAct || busy !== null) return;
    // Guard against nullable identity masquerading as string
    if (
      frozen.requestId === null ||
      typeof frozen.requestId !== "string" ||
      frozen.requestId.length === 0 ||
      !Number.isInteger(frozen.attempt) ||
      !Number.isInteger(frozen.generation)
    ) {
      setError(
        "This approval lacks a durable request identity and cannot be resolved — retry the node.",
      );
      return;
    }
    setBusy(decision);
    setError(null);
    // keep done null until success so we can fence synchronously
    try {
      const trimmed = note.trim();
      await resolveApproval(runId, path, {
        requestId: frozen.requestId as string,
        expectedAttempt: frozen.attempt as number,
        expectedGeneration: frozen.generation as number,
        decision,
        ...(trimmed === "" ? {} : { note: trimmed }),
      });
      setDone(
        decision === "approve"
          ? "Approved — the run will continue."
          : "Rejected — the run will follow the rejected handle or end as rejected.",
      );
      // Fence synchronously until projection catches up: keep buttons disabled via done !== null
    } catch (err) {
      const failure = classifyError(err);
      const code = (err as { code?: string | null }).code ?? failure.code;
      if (code === "E_CONFLICT" || (err as { status?: number }).status === 409) {
        setError(
          "This approval was already resolved or is stale. Reload the run to see the current decision.",
        );
      } else {
        setError(failure.message);
      }
      setBusy(null);
      return;
    }
    setBusy(null);
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      {pending ? (
        <div className="col" style={{ gap: 8 }} data-testid="approval-actions-top">
          <div className="col" style={{ gap: 8 }} data-testid="approval-pending">
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                data-testid="approval-approve"
                disabled={!canAct}
                aria-busy={busy === "approve"}
                onClick={() => void act("approve")}
              >
                {busy === "approve" ? "Approving…" : "Approve"}
              </button>
              <button
                type="button"
                className="btn danger"
                data-testid="approval-reject"
                disabled={!canAct}
                aria-busy={busy === "reject"}
                onClick={() => void act("reject")}
              >
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </div>
            {isReplay ? (
              <div className="note amber" data-testid="approval-replay-guard">
                Replay view — decisions are disabled. Go to live to approve or reject.
              </div>
            ) : null}
            {error ? (
              <p className="inspector-error" role="alert" data-testid="approval-error">
                {error}
              </p>
            ) : null}
            {done ? (
              <p className="note green" role="status" data-testid="approval-done">
                {done}
              </p>
            ) : null}
            <label className="inspector-label" htmlFor="approval-note">
              Optional note
            </label>
            <textarea
              id="approval-note"
              data-testid="approval-note"
              className="inspector-input inspector-textarea"
              rows={2}
              value={note}
              maxLength={4096}
              placeholder="Add a short note for the audit trail (optional)"
              aria-describedby="approval-note-help"
              disabled={isReplay || busy !== null || done !== null}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
            <p id="approval-note-help" className="faint">
              Approved handle is <span className="mono">{path}</span>; rejected is{" "}
              <span className="mono">{path}.rejected</span>. Without a rejected edge the run ends as
              rejected.
            </p>
          </div>
        </div>
      ) : null}
      <div className={`note ${frozen.irreversible ? "amber" : ""}`} data-testid="approval-request">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="pill amber">Human review</span>
          {frozen.irreversible ? <span className="pill red">Irreversible</span> : null}
          <span className="faint mono">
            request{" "}
            {frozen.requestId === null || frozen.requestId === ""
              ? "legacy (no durable id)"
              : frozen.requestId}
          </span>
          <span className="faint mono">
            attempt {frozen.attempt === null ? "—" : frozen.attempt} gen{" "}
            {frozen.generation === null ? "—" : frozen.generation}
          </span>
        </div>
        <div style={{ whiteSpace: "pre-wrap", marginTop: 8 }} data-testid="approval-message">
          {frozen.message}
        </div>
        {frozen.criteria && frozen.criteria.length > 0 ? (
          <ul style={{ marginTop: 8 }} data-testid="approval-criteria">
            {frozen.criteria.map((item, idx) => {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: criteria order stable by authoring, duplicates allowed
                <li key={idx}>{item}</li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div>
        <h3 style={{ margin: "4px 0 6px" }}>Upstream outputs</h3>
        <p className="faint" style={{ marginBottom: 6 }}>
          Structured snapshots and bounded previews, not the raw inputs hash.
        </p>
        <UpstreamOutputs path={path} snapshot={snapshot} runId={runId} isReplay={isReplay} />
      </div>

      {resolved ? (
        <div className="note green" data-testid="approval-resolved">
          <span>
            <b>{resolved.decision === "approve" ? "Approved" : "Rejected"}</b> by {resolved.by}{" "}
            (request {resolved.requestId}→ decision at replay head #{view.lastEventId})
          </span>
          {resolved.note ? <div className="mono">note: {resolved.note}</div> : null}
        </div>
      ) : null}

      {pending ? null : (
        <p className="faint" data-testid="approval-settled-note">
          This approval is no longer pending at this event. {isReplay ? "Replaying history." : ""}
        </p>
      )}
    </div>
  );
}
