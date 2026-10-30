import type { WorkflowNode as NodeDefinition, WorkflowParam } from "@devchestra/schema";
import { useEffect, useState } from "react";
import { classifyError } from "../../api/client.js";
import { workflowApi } from "../api/workflowApi.js";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import { SchemaEditor } from "./schema/SchemaEditor.js";
import type { FormProps } from "./types.js";

type CallNode = Extract<NodeDefinition, { type: "workflow" }>;

/** Parameter mappings stay expressions, so numbers/objects are not stringified. */
export function WorkflowForm({
  node,
  issues,
  onPatch,
  projectId,
}: FormProps<CallNode> & { projectId?: string | undefined }) {
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [params, setParams] = useState<WorkflowParam[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [parameterError, setParameterError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [extraName, setExtraName] = useState("");

  useEffect(() => {
    setWorkflows([]);
    setLoadError(null);
    if (!projectId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        let cursor: string | undefined;
        const found: { id: string; name: string }[] = [];
        do {
          const page = await workflowApi.list(
            projectId,
            { limit: 200, ...(cursor ? { cursor } : {}) },
            { signal: abort.signal },
          );
          found.push(...page.items.map((item) => ({ id: item.id, name: item.name })));
          cursor = page.nextCursor ?? undefined;
        } while (cursor && found.length < 2000 && !abort.signal.aborted);
        if (!abort.signal.aborted) setWorkflows(found);
      } catch (error) {
        if (!abort.signal.aborted) setLoadError(classifyError(error).message);
      }
    })();
    return () => abort.abort();
  }, [projectId]);

  useEffect(() => {
    setParams([]);
    setParameterError(null);
    setLoading(false);
    if (!projectId || !node.workflowId) return;
    const abort = new AbortController();
    setLoading(true);
    void workflowApi
      .get(projectId, node.workflowId, { signal: abort.signal })
      .then((document) => {
        if (abort.signal.aborted) return;
        const start = document.workflow.graph.nodes.find((entry) => entry.type === "start");
        setParams(start?.type === "start" ? start.params : []);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setParameterError(classifyError(error).message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, node.workflowId]);

  const names = [...new Set([...params.map((param) => param.name), ...Object.keys(node.inputs)])];
  const setMapping = (name: string, value: string) => {
    const inputs = { ...node.inputs };
    if (value.trim() === "") delete inputs[name];
    else inputs[name] = value;
    onPatch({ inputs });
  };

  return (
    <>
      <InspectorSection sectionKey="workflow:target" title="Reusable workflow">
        <div className="inspector-stack">
          <Field
            id="inspector-workflow-id"
            label="Workflow"
            required
            error={fieldIssue(issues, "/workflowId")}
            help="Same project only. Its definition is frozen when this run starts; edits during a batch do not change later items."
          >
            {projectId && workflows.length > 0 ? (
              <select
                id="inspector-workflow-id"
                className="inspector-input"
                data-testid="inspector-workflow-id"
                value={node.workflowId}
                onChange={(event) => onPatch({ workflowId: event.currentTarget.value })}
              >
                <option value="">Choose a workflow…</option>
                {node.workflowId && !workflows.some((entry) => entry.id === node.workflowId) ? (
                  <option value={node.workflowId}>{node.workflowId} (not listed)</option>
                ) : null}
                {workflows.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="inspector-workflow-id"
                className="inspector-input"
                data-testid="inspector-workflow-id"
                value={node.workflowId}
                placeholder="workflow-id"
                onChange={(event) => onPatch({ workflowId: event.currentTarget.value })}
              />
            )}
          </Field>
          {loadError ? (
            <p className="inspector-help" role="status">
              Could not list workflows: {loadError}. You can enter the workflow ID directly.
            </p>
          ) : null}
          <p className="inspector-help">
            Success continues normally. Connect the failed output to handle a failed or rejected
            child. Cancellation stops the invocation rather than becoming a recoverable failure.
          </p>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="workflow:inputs" title="Input mappings">
        <div className="inspector-stack">
          <p className="inspector-help">
            Each value is a JSONata expression, without double braces. Leave an optional mapping
            blank to use the child workflow’s default. Use the variable picker to select the current
            item or parent inputs.
          </p>
          {loading ? (
            <p className="inspector-help" role="status">
              Loading workflow parameters…
            </p>
          ) : null}
          {parameterError ? (
            <p className="inspector-error" role="alert">
              Cannot inspect target parameters: {parameterError}
            </p>
          ) : null}
          {names.map((name) => {
            const param = params.find((entry) => entry.name === name);
            const id = `inspector-workflow-input-${name}`;
            return (
              <Field
                key={name}
                id={id}
                label={name}
                required={param?.required === true && param.default === undefined}
                help={
                  param
                    ? `${param.type}${param.default === undefined ? "" : ` · default ${JSON.stringify(param.default)}`}`
                    : "Saved mapping; target parameter could not be confirmed."
                }
                error={fieldIssue(
                  issues,
                  `/inputs/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
                )}
              >
                <ExpandableTextarea
                  id={id}
                  label={`Input: ${name}`}
                  value={node.inputs[name] ?? ""}
                  onCommit={(next) => setMapping(name, next)}
                  mode="expression"
                  nodeId={node.id}
                  field={`inputs.${name}`}
                  textareaTestId={id}
                  rows={2}
                  spellCheck={false}
                  className="inspector-input inspector-textarea inspector-code-input"
                />
              </Field>
            );
          })}
          <div className="row" style={{ gap: 6 }}>
            <input
              className="inspector-input"
              aria-label="Additional input name"
              placeholder="Parameter name"
              value={extraName}
              onChange={(event) => setExtraName(event.currentTarget.value)}
            />
            <button
              type="button"
              className="btn sm"
              disabled={
                !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(extraName) || names.includes(extraName)
              }
              onClick={() => {
                onPatch({ inputs: { ...node.inputs, [extraName]: "null" } });
                setExtraName("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="workflow:output" title="Child result schema">
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={node.output !== undefined}
            onChange={(event) =>
              onPatch({
                output: event.currentTarget.checked
                  ? { type: "object", additionalProperties: true }
                  : undefined,
              })
            }
          />
          Validate the successful child result
        </label>
        {node.output ? (
          <SchemaEditor
            schema={node.output}
            issues={issues}
            onPatch={(output) => onPatch({ output })}
          />
        ) : (
          <p className="inspector-help">
            Without a declared schema, the picker offers the whole result. The node also returns
            childRunId and status.
          </p>
        )}
      </InspectorSection>
    </>
  );
}
