import type { Edge, JoinNode } from "@relay/schema";
import { GitMerge, Plus, Trash2 } from "lucide-react";
import {
  addJoinInput,
  HANDLE_ID_PATTERN,
  removeJoinInput,
  renameJoinInput,
} from "../model/routing.js";
import { useBufferFlag } from "./BufferContext.js";
import { describedBy, Field } from "./fields/fields.js";
import { useBufferedHandle } from "./fields/useBufferedHandle.js";
import { fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import { SchemaEditor } from "./schema/SchemaEditor.js";
import type { RoutingFormProps } from "./types.js";

function InputRow({
  node,
  name,
  index,
  edges,
  onRoutingChange,
}: {
  node: JoinNode;
  name: string;
  index: number;
  edges: readonly Edge[];
  onRoutingChange: RoutingFormProps<JoinNode>["onRoutingChange"];
}) {
  const committed = useBufferedHandle(
    name,
    (next) => {
      if (!HANDLE_ID_PATTERN.test(next)) {
        return "Input name must start with a letter or digit and use only letters, digits, underscores or hyphens.";
      }
      if (next !== name && node.inputs.includes(next)) return `Input '${next}' already exists.`;
      if (next !== name && edges.some((edge) => edge.to === `${node.id}.${name}`)) {
        return "This input is connected. Disconnect its edge before renaming the handle.";
      }
      return null;
    },
    (next) => {
      if (next === name) return;
      const updated = renameJoinInput(node, name, next);
      if (updated !== null) onRoutingChange({ inputs: updated.inputs });
    },
    `join.${node.id}.input.${name}`,
  );
  const connected = edges.filter((edge) => edge.to === `${node.id}.${name}`).length;
  return (
    <div className="inspector-schema-row" data-testid={`join-input-${index}`}>
      <div className="inspector-row-head">
        <span className="inspector-row-title">Input {index + 1}</span>
        <span className="faint">
          {connected} connection{connected === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="btn ghost sm danger"
          data-testid={`join-input-${index}-remove`}
          aria-label={`Remove input ${index + 1}`}
          onClick={() => {
            const updated = removeJoinInput(node, name);
            if (updated === null) return;
            const removed = edges
              .filter((edge) => edge.to === `${node.id}.${name}`)
              .map((edge) => edge.id);
            onRoutingChange({ inputs: updated.inputs }, removed);
          }}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      <Field
        id={`join-input-${index}-name`}
        label="Input name (handle)"
        required
        help="Edges target joinId.inputName. Renaming is blocked while the input has a connection."
        error={committed.localError}
      >
        <input
          id={`join-input-${index}-name`}
          className="inspector-input"
          data-testid={`join-input-${index}-name`}
          type="text"
          value={committed.text}
          aria-invalid={committed.localError ? true : undefined}
          aria-describedby={describedBy(
            `join-input-${index}-name`,
            undefined,
            committed.localError,
          )}
          onChange={(event) => committed.onChange(event.currentTarget.value)}
          onBlur={committed.onBlur}
          onKeyDown={committed.onKeyDown}
        />
      </Field>
    </div>
  );
}

export function JoinForm({ node, issues, edges, onRoutingChange }: RoutingFormProps<JoinNode>) {
  const modeIssue = fieldIssue(issues, "/mode");
  const inputsIssue = fieldIssue(issues, "/inputs");
  const outputIssue = fieldIssue(issues, "/output");
  useBufferFlag("join.inputs", inputsIssue);
  return (
    <>
      <InspectorSection sectionKey="join:shape" title="Join inputs">
        <div className="inspector-stack">
          <Field
            id="join-mode"
            label="Mode"
            help="All waits for every declared input. First forwards the single active input."
            error={modeIssue}
          >
            <select
              id="join-mode"
              className="inspector-input"
              data-testid="join-mode"
              value={node.mode}
              aria-invalid={modeIssue ? true : undefined}
              aria-describedby={describedBy("join-mode", undefined, modeIssue)}
              onChange={(event) =>
                onRoutingChange({ mode: event.currentTarget.value as JoinNode["mode"] })
              }
            >
              <option value="all">All inputs</option>
              <option value="first">First active input</option>
            </select>
          </Field>
          <p className="inspector-help">
            <GitMerge size={12} aria-hidden="true" /> Every declared input needs exactly one
            incoming edge. Dead inputs resolve to null in All mode.
          </p>
          {node.inputs.length === 0 ? (
            <p className="inspector-error" role="alert">
              A join needs at least one input.
            </p>
          ) : (
            node.inputs.map((name, index) => (
              <InputRow
                key={name}
                node={node}
                name={name}
                index={index}
                edges={edges}
                onRoutingChange={onRoutingChange}
              />
            ))
          )}
          {inputsIssue ? (
            <p className="inspector-error" role="alert">
              {inputsIssue}
            </p>
          ) : null}
          <div className="inspector-inline">
            <button
              type="button"
              className="btn sm"
              data-testid="join-input-add"
              onClick={() => {
                const updated = addJoinInput(node);
                onRoutingChange({ inputs: updated.inputs });
              }}
            >
              <Plus size={13} aria-hidden="true" />
              Add input
            </button>
          </div>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="join:output" title="Output schema">
        <div className="inspector-stack">
          <label className="inspector-check">
            <input
              type="checkbox"
              data-testid="join-output-toggle"
              checked={node.output !== undefined}
              onChange={(event) =>
                onRoutingChange(
                  event.currentTarget.checked
                    ? { output: { type: "object", additionalProperties: true } }
                    : ({ output: undefined } as Partial<import("@relay/schema").WorkflowNode>),
                )
              }
            />
            <span>Declare an output schema</span>
          </label>
          <p className="inspector-help">
            Optional. Required for a First-mode join referenced by an expression when source schemas
            differ.
          </p>
          {node.output === undefined ? null : (
            <SchemaEditor
              schema={node.output}
              issues={issues}
              onPatch={(output) => onRoutingChange({ output })}
            />
          )}
          {outputIssue ? (
            <p className="inspector-error" role="alert">
              {outputIssue}
            </p>
          ) : null}
        </div>
      </InspectorSection>
    </>
  );
}
