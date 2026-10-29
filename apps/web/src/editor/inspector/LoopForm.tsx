import type { Edge, Graph, Issue, LoopNode, WorkflowFile, WorkflowNode } from "@devchestra/schema";
import { validateLoopNode } from "@devchestra/schema";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EditorCanvas } from "../canvas/EditorCanvas.js";
import { NodePalette } from "../canvas/Palette.js";
import { Dialog } from "../controls/Dialog.js";
import { createDefaultNode } from "../model/graph.js";
import type { EditorSelection } from "../model/types.js";
import { useBufferFlag } from "./BufferContext.js";
import { describedBy, Field } from "./fields/fields.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { containingIssue, fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import { SchemaEditor } from "./schema/SchemaEditor.js";
import type { FormProps } from "./types.js";

export type BodyInspectorRender = (
  node: WorkflowNode,
  issues: readonly Issue[],
  onPatch: (patch: Partial<WorkflowNode>) => void,
  edges: readonly Edge[],
  onRoutingChange: (patch: Partial<WorkflowNode>, removeEdgeIds?: readonly string[]) => void,
) => ReactNode;

interface LoopFormProps extends FormProps<LoopNode> {
  renderBodyInspector: BodyInspectorRender;
}

function nonEmpty(value: string, label: string): string | null {
  return value.trim() === "" ? `${label} is required.` : null;
}

export function LoopForm({ node, issues, onPatch, renderBodyInspector }: LoopFormProps) {
  const [bodyOpen, setBodyOpen] = useState(false);
  const maxIssue = fieldIssue(issues, "/maxIterations");
  const initialIssue = fieldIssue(issues, "/initialState");
  const resultIssue = fieldIssue(issues, "/result");
  const untilIssue = fieldIssue(issues, "/until");
  const nextIssue = fieldIssue(issues, "/nextState");
  const bodyIssue = containingIssue(issues, "/body");

  const max = useBufferedNumber(node.maxIterations, {
    label: "Max iterations",
    min: 1,
    max: 1000,
    integer: true,
    allowEmpty: false,
    bufferKey: `loop.${node.id}.maxIterations`,
    onCommit: (value) => {
      if (value !== undefined && value !== node.maxIterations) onPatch({ maxIterations: value });
    },
  });
  const initial = useBufferedText(
    node.initialState ?? "{}",
    () => null,
    (v) => {
      if (v !== (node.initialState ?? "{}")) onPatch({ initialState: v.trim() === "" ? "{}" : v });
    },
    `loop.${node.id}.initialState`,
  );
  const result = useBufferedText(
    node.result,
    (v) => nonEmpty(v, "Result"),
    (v) => {
      if (v !== node.result) onPatch({ result: v });
    },
    `loop.${node.id}.result`,
  );
  const until = useBufferedText(
    node.until,
    (v) => nonEmpty(v, "Until"),
    (v) => {
      if (v !== node.until) onPatch({ until: v });
    },
    `loop.${node.id}.until`,
  );
  const next = useBufferedText(
    node.nextState ?? "loop.state",
    () => null,
    (v) => {
      const current = node.nextState ?? "loop.state";
      if (v !== current) onPatch({ nextState: v.trim() === "" ? "loop.state" : v });
    },
    `loop.${node.id}.nextState`,
  );

  return (
    <>
      <InspectorSection sectionKey="loop:limits" title="Limits">
        <div className="inspector-stack">
          <Field
            id="inspector-loop-max"
            label="Max iterations"
            required
            help="Required integer from 1 to 1000."
            error={max.localError ?? maxIssue}
          >
            <input
              id="inspector-loop-max"
              className="inspector-input"
              data-testid="inspector-loop-max"
              value={max.text}
              inputMode="numeric"
              aria-invalid={(max.localError ?? maxIssue) ? true : undefined}
              aria-describedby={describedBy(
                "inspector-loop-max",
                undefined,
                max.localError ?? maxIssue,
              )}
              onChange={(e) => max.onChange(e.currentTarget.value)}
            />
          </Field>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="loop:expressions" title="Expressions">
        <div className="inspector-stack">
          <Field
            id="inspector-loop-initial"
            label="Initial state (JSONata, optional)"
            help="Evaluated once in the parent scope. Defaults to {}."
            error={initialIssue}
          >
            <textarea
              id="inspector-loop-initial"
              className="inspector-input inspector-textarea inspector-code-input"
              data-testid="inspector-loop-initial"
              rows={2}
              spellCheck={false}
              value={initial.text}
              aria-describedby={describedBy("inspector-loop-initial", undefined, initialIssue)}
              onChange={(e) => initial.onChange(e.currentTarget.value)}
            />
          </Field>
          <Field
            id="inspector-loop-result"
            label="Result (JSONata)"
            required
            help="Evaluated over the current round's ancestors of End."
            error={result.localError ?? resultIssue}
          >
            <textarea
              id="inspector-loop-result"
              className="inspector-input inspector-textarea inspector-code-input"
              data-testid="inspector-loop-result"
              rows={3}
              spellCheck={false}
              value={result.text}
              aria-describedby={describedBy(
                "inspector-loop-result",
                undefined,
                result.localError ?? resultIssue,
              )}
              onChange={(e) => result.onChange(e.currentTarget.value)}
            />
          </Field>
          <Field
            id="inspector-loop-until"
            label="Until (JSONata boolean)"
            required
            help="True completes the loop. False on the final round fails with E_LOOP_LIMIT."
            error={until.localError ?? untilIssue}
          >
            <textarea
              id="inspector-loop-until"
              className="inspector-input inspector-textarea inspector-code-input"
              data-testid="inspector-loop-until"
              rows={2}
              spellCheck={false}
              value={until.text}
              aria-describedby={describedBy(
                "inspector-loop-until",
                undefined,
                until.localError ?? untilIssue,
              )}
              onChange={(e) => until.onChange(e.currentTarget.value)}
            />
          </Field>
          <Field
            id="inspector-loop-next"
            label="Next state (JSONata, optional)"
            help="Evaluated when continuing. Defaults to loop.state."
            error={nextIssue}
          >
            <textarea
              id="inspector-loop-next"
              className="inspector-input inspector-textarea inspector-code-input"
              data-testid="inspector-loop-next"
              rows={2}
              spellCheck={false}
              value={next.text}
              aria-describedby={describedBy("inspector-loop-next", undefined, nextIssue)}
              onChange={(e) => next.onChange(e.currentTarget.value)}
            />
          </Field>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="loop:output" title="Output schema">
        <SchemaEditor
          schema={node.output}
          issues={issues}
          onPatch={(output) => onPatch({ output })}
        />
      </InspectorSection>
      <InspectorSection sectionKey="loop:body" title="Body">
        {bodyIssue ? (
          <p className="inspector-error" role="alert" data-testid="inspector-loop-body-error">
            {bodyIssue}
          </p>
        ) : null}
        <p className="inspector-help" data-testid="inspector-loop-body-hint">
          One Start (no params) and one successful End. No nested loops. Body nodes see
          loop.iteration, loop.maxIterations, loop.state and loop.parent. Edits stay local until
          Apply.
        </p>
        <button
          type="button"
          className="btn"
          data-testid="loop-body-open"
          onClick={() => setBodyOpen(true)}
        >
          Edit body ({node.body.nodes.length} nodes)
        </button>
        <Dialog
          open={bodyOpen}
          title={`Body of ${node.name}`}
          wide
          testId="loop-body-dialog"
          description="Apply saves the body to the workflow. Cancel or close discards unapplied body changes."
          onClose={() => setBodyOpen(false)}
        >
          {bodyOpen ? (
            <LoopBodyEditor
              node={node}
              onPatch={onPatch}
              renderBodyInspector={renderBodyInspector}
              onDone={() => setBodyOpen(false)}
            />
          ) : null}
        </Dialog>
      </InspectorSection>
    </>
  );
}

function toBodyFile(node: LoopNode, draft: Graph): WorkflowFile {
  return { schemaVersion: 1, id: "loop-body", name: `Body of ${node.id}`, graph: draft };
}

function BodyNodeInspector({
  selected,
  edges,
  setDraft,
  renderBodyInspector,
}: {
  selected: WorkflowNode;
  edges: readonly Edge[];
  setDraft: React.Dispatch<React.SetStateAction<Graph>>;
  renderBodyInspector: BodyInspectorRender;
}) {
  if (selected.type === "loop") return <p className="faint">Nested loops are not supported.</p>;
  return renderBodyInspector(
    selected,
    [],
    (patch) => patchSelected(setDraft, selected.id, patch),
    edges,
    (patch, remove) => routeSelected(setDraft, selected.id, patch, remove),
  );
}

function patchSelected(
  setDraft: React.Dispatch<React.SetStateAction<Graph>>,
  id: string,
  patch: Partial<WorkflowNode>,
): void {
  // Same-node merge: the patch only carries that node's own fields.
  setDraft((prev) => ({
    ...prev,
    nodes: prev.nodes.map((entry) =>
      entry.id === id ? ({ ...entry, ...patch } as WorkflowNode) : entry,
    ),
  }));
}

function routeSelected(
  setDraft: React.Dispatch<React.SetStateAction<Graph>>,
  id: string,
  patch: Partial<WorkflowNode>,
  removeEdgeIds?: readonly string[],
): void {
  // Same-node merge plus connected-edge removal for handle identity edits.
  setDraft((prev) => ({
    ...prev,
    nodes: prev.nodes.map((entry) =>
      entry.id === id ? ({ ...entry, ...patch } as WorkflowNode) : entry,
    ),
    edges:
      removeEdgeIds === undefined || removeEdgeIds.length === 0
        ? prev.edges
        : prev.edges.filter((e) => !removeEdgeIds.includes(e.id)),
  }));
}

function LoopBodyEditor({
  node,
  onPatch,
  renderBodyInspector,
  onDone,
}: {
  node: LoopNode;
  onPatch: (patch: Partial<LoopNode>) => void;
  renderBodyInspector: BodyInspectorRender;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<Graph>(() => structuredClone(node.body));
  const [selection, setSelection] = useState<EditorSelection>(null);
  const [lastCommitted, setLastCommitted] = useState(() => JSON.stringify(node.body));
  const currentKey = JSON.stringify(node.body);
  const dirty = JSON.stringify(draft) !== currentKey;

  // Reset local edits when the outer body changes (undo/redo or external edit).
  useEffect(() => {
    if (currentKey !== lastCommitted) {
      setDraft(structuredClone(node.body));
      setLastCommitted(currentKey);
      setSelection(null);
    }
  }, [currentKey, lastCommitted, node.body]);

  // Block outer autosave/navigation while unapplied body edits exist.
  useBufferFlag(`loop.${node.id}.body`, dirty ? "Body has unapplied changes." : null);

  const bodyFile = useMemo(() => toBodyFile(node, draft), [node, draft]);

  // Validate the draft body with a parent-scope-neutral initialState. The outer
  // initialState is validated elsewhere with the real parent scope; defaulting
  // here would falsely block Apply for valid outer ancestors (e.g. prepare.config).
  const draftIssues = useMemo(
    () =>
      validateLoopNode(
        { ...node, body: draft, initialState: "{}" },
        { pointer: `/graph/nodes/${node.id}` },
      ),
    [node, draft],
  );
  const draftErrors = useMemo(
    () => draftIssues.filter((i) => i.severity === "error"),
    [draftIssues],
  );
  const canApply = dirty && draftErrors.length === 0;

  const apply = (): void => {
    if (!canApply) return;
    onPatch({ body: structuredClone(draft) });
    setLastCommitted(JSON.stringify(draft));
    onDone();
  };
  const cancel = (): void => {
    setDraft(structuredClone(node.body));
    setSelection(null);
    onDone();
  };

  const addNode = (type: string): void => {
    if (type === "loop") return;
    const created = createDefaultNode(type, draft.nodes);
    if (created.type === "loop") return;
    const next: Graph = { nodes: [...draft.nodes, created], edges: [...draft.edges] };
    setDraft(next);
    setSelection({ kind: "node", nodeId: created.id });
  };

  const selected =
    selection?.kind === "node"
      ? (draft.nodes.find((n) => n.id === selection.nodeId) ?? null)
      : null;

  return (
    <div className="loop-body-editor" data-testid="loop-body-editor">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <span className={`chip${dirty ? " amber" : ""}`} data-testid="loop-body-dirty">
          {dirty ? "Unapplied changes" : "Body in sync"}
        </span>
        <span className="sp" />
        <button
          type="button"
          className="btn sm"
          data-testid="loop-body-apply"
          disabled={!canApply}
          onClick={apply}
        >
          Apply body
        </button>
        <button type="button" className="btn sm" data-testid="loop-body-cancel" onClick={cancel}>
          Cancel
        </button>
      </div>
      {draftErrors.length > 0 ? (
        <ul className="inspector-errors" data-testid="loop-body-errors">
          {draftErrors.map((issue) => (
            <li
              key={`${issue.code}:${issue.pointer ?? ""}:${issue.message}`}
              className="inspector-error"
            >
              <b>{issue.code}</b> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="loop-body-layout">
        <NodePalette file={bodyFile} onAdd={addNode} hiddenTypes={["loop"]} />
        <div
          data-testid="loop-body-canvas"
          style={{ height: 420, minHeight: 320, width: "100%", position: "relative" }}
        >
          <EditorCanvas
            file={bodyFile}
            selection={selection}
            issues={[]}
            onSelectionChange={setSelection}
            onChange={(next) => setDraft(next.graph)}
            onConnectionRejected={() => {}}
          />
        </div>
      </div>
      <div data-testid="loop-body-inspector">
        {selected === null ? (
          <p className="faint">
            Select a body node to edit it. Start takes no parameters; End must stay success.
          </p>
        ) : (
          <BodyNodeInspector
            selected={selected}
            edges={bodyFile.graph.edges}
            setDraft={setDraft}
            renderBodyInspector={renderBodyInspector}
          />
        )}
      </div>
    </div>
  );
}
