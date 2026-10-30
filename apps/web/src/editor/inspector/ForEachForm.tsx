import type { ForEachNode } from "@devchestra/schema";
import { useEffect, useState } from "react";
import { Dialog } from "../controls/Dialog.js";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { Field } from "./fields/fields.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { containingIssue, fieldIssue } from "./issues.js";
import { type BodyInspectorRender, ControllerBodyEditor } from "./LoopForm.js";
import { InspectorSection } from "./Section.js";
import { SchemaEditor } from "./schema/SchemaEditor.js";
import type { FormProps } from "./types.js";

export function ForEachForm({
  node,
  issues,
  onPatch,
  renderBodyInspector,
  openRequested,
  onOpenHandled,
}: FormProps<ForEachNode> & {
  renderBodyInspector: BodyInspectorRender;
  openRequested?: boolean | undefined;
  onOpenHandled?: (() => void) | undefined;
}) {
  const [bodyOpen, setBodyOpen] = useState(false);
  useEffect(() => {
    if (!openRequested) return;
    setBodyOpen(true);
    onOpenHandled?.();
  }, [openRequested, onOpenHandled]);
  const max = useBufferedNumber(node.maxItems ?? 1000, {
    label: "Maximum items",
    min: 1,
    max: 1000,
    integer: true,
    allowEmpty: false,
    bufferKey: `foreach.${node.id}.maxItems`,
    onCommit: (value) => {
      if (value !== undefined && value !== node.maxItems) onPatch({ maxItems: value });
    },
  });
  const result = useBufferedText(
    node.result,
    (value) => (value.trim() ? null : "Item result is required."),
    (value) => {
      if (value !== node.result) onPatch({ result: value });
    },
    `foreach.${node.id}.result`,
  );
  const source = node.source;
  const sourceValue = source.kind === "csv" ? source.path : source.expression;
  const bodyIssue = containingIssue(issues, "/body");
  return (
    <>
      <InspectorSection sectionKey="foreach:source" title="Items">
        <div className="inspector-stack">
          <Field id="inspector-foreach-kind" label="Items source">
            <select
              id="inspector-foreach-kind"
              className="inspector-input"
              value={source.kind}
              onChange={(event) =>
                onPatch({
                  source:
                    event.currentTarget.value === "csv"
                      ? { kind: "csv", path: "jobs.csv" }
                      : { kind: "expression", expression: "[]" },
                })
              }
            >
              <option value="expression">Array expression</option>
              <option value="csv">CSV file</option>
            </select>
          </Field>
          <Field
            id="inspector-foreach-source"
            label={source.kind === "csv" ? "CSV path (template)" : "Items (JSONata array)"}
            required
            error={fieldIssue(
              issues,
              source.kind === "csv" ? "/source/path" : "/source/expression",
            )}
            help={
              source.kind === "csv"
                ? "Workspace-relative CSV with a header row. Quoted multiline values are supported. The list is frozen when this node starts."
                : "Evaluated once in the parent scope. Must return an array. An empty array completes without running the body."
            }
          >
            <ExpandableTextarea
              id="inspector-foreach-source"
              label="For-each items source"
              nodeId={node.id}
              field={source.kind === "csv" ? "source.path" : "source.expression"}
              mode={source.kind === "csv" ? "template" : "expression"}
              value={sourceValue}
              onCommit={(value) =>
                onPatch({
                  source:
                    source.kind === "csv"
                      ? { kind: "csv", path: value }
                      : { kind: "expression", expression: value },
                })
              }
              textareaTestId="inspector-foreach-source"
              rows={3}
              spellCheck={false}
            />
          </Field>
          <Field
            id="inspector-foreach-max"
            label="Maximum items"
            error={max.localError ?? fieldIssue(issues, "/maxItems")}
            help="Safety bound from 1 to 1000. Oversized collections fail; they are not silently truncated."
          >
            <input
              id="inspector-foreach-max"
              className="inspector-input"
              inputMode="numeric"
              value={max.text}
              onChange={(event) => max.onChange(event.currentTarget.value)}
            />
          </Field>
          <Field id="inspector-foreach-policy" label="If an item fails">
            <select
              id="inspector-foreach-policy"
              className="inspector-input"
              value={node.onItemFailure ?? "stop"}
              onChange={(event) =>
                onPatch({
                  onItemFailure: event.currentTarget.value === "continue" ? "continue" : "stop",
                })
              }
            >
              <option value="stop">Stop the batch</option>
              <option value="continue">Record failure and continue</option>
            </select>
          </Field>
          <p className="inspector-help">
            Items run sequentially. Cancellation always stops the batch, regardless of failure
            policy.
          </p>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="foreach:result" title="Per-item result">
        <Field
          id="inspector-foreach-result"
          label="Item result (JSONata)"
          required
          help="Mapped after a successful item body. Large batch results are stored by reference, not accumulated in loop state."
          error={result.localError ?? fieldIssue(issues, "/result")}
        >
          <ExpandableTextarea
            id="inspector-foreach-result"
            label="For-each item result"
            nodeId={node.id}
            field="result"
            mode="expression"
            value={result.text}
            onCommit={result.onChange}
            validate={(value) => (value.trim() ? null : "Item result is required.")}
            textareaTestId="inspector-foreach-result"
            rows={3}
            spellCheck={false}
            error={result.localError ?? fieldIssue(issues, "/result")}
            bufferKey={`foreach.${node.id}.result`}
          />
        </Field>
        <SchemaEditor
          schema={node.output}
          issues={issues}
          onPatch={(output) => onPatch({ output })}
        />
      </InspectorSection>
      <InspectorSection sectionKey="foreach:body" title="Item body">
        {bodyIssue ? (
          <p className="inspector-error" role="alert">
            {bodyIssue}
          </p>
        ) : null}
        <p className="inspector-help">
          Body nodes see foreach.item, index (zero-based), number (one-based), total, and parent.
          Add Run workflow to invoke a workflow containing its own retry loop. Direct nested
          collection/loop bodies are not supported.
        </p>
        <button
          type="button"
          className="btn"
          data-testid="foreach-body-open"
          onClick={() => setBodyOpen(true)}
        >
          Edit item body ({node.body.nodes.length} nodes)
        </button>
        <Dialog
          open={bodyOpen}
          title={`Item body of ${node.name}`}
          workspace
          testId="foreach-body-dialog"
          description="Apply saves this body. Cancel or close discards unapplied edits."
          onClose={() => setBodyOpen(false)}
        >
          {bodyOpen ? (
            <ControllerBodyEditor
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
