import type { AgentNode } from "@relay/schema";
import { isRecord } from "@relay/core";
import { Bot } from "lucide-react";
import { AgentLimits } from "./AgentLimits.js";
import { AgentModelField } from "./AgentModelField.js";
import { AgentPermissions } from "./AgentPermissions.js";
import { AgentPrompt } from "./AgentPrompt.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";
import { InspectorSection } from "./Section.js";
import { SchemaEditor } from "./schema/SchemaEditor.js";
import type { FormProps } from "./types.js";

export function AgentForm({
  node,
  issues,
  onPatch,
  projectId,
}: FormProps<AgentNode> & { projectId?: string | undefined }) {
  const cliIssue = fieldIssue(issues, "/cli");
  const { clis } = useAvailableClis();
  const selected = clis.find((entry) => entry.id === node.cli);
  const properties = isRecord(node.output.properties) ? Object.keys(node.output.properties) : [];

  return (
    <>
      <InspectorSection sectionKey="agent:agent" title="Agent">
        <div className="inspector-stack">
          <Field
            id="inspector-agent-cli"
            label="CLI"
            required
            error={cliIssue}
            help={selected?.help}
          >
            <select
              id="inspector-agent-cli"
              className="inspector-input"
              data-testid="inspector-agent-cli"
              value={node.cli}
              aria-invalid={cliIssue ? true : undefined}
              aria-describedby={describedBy("inspector-agent-cli", selected?.help, cliIssue)}
              onChange={(event) => {
                const next = event.currentTarget.value as AgentNode["cli"];
                if (next !== node.cli) onPatch({ cli: next, model: undefined });
              }}
            >
              {clis.map((cli) => (
                <option key={cli.id} value={cli.id}>
                  {cli.label}
                </option>
              ))}
            </select>
          </Field>
          <AgentModelField
            key={`${node.id}:${node.cli}`}
            node={node}
            projectId={projectId}
            issues={issues}
            onPatch={onPatch}
          />
          {selected?.help === undefined ? null : (
            <p className="inspector-note amber" role="note">
              <Bot size={13} aria-hidden="true" />
              <span>
                {selected.label} is an experimental adapter. Relay does not provide an OS sandbox,
                and permission enforcement is unverified.
              </span>
            </p>
          )}
          <p className="inspector-help">
            Context reads, env passthrough, cliOptions, provider keys and budgets are not
            implemented in P1 and are not exposed here.
          </p>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="agent:prompt" title="Prompt">
        <AgentPrompt node={node} issues={issues} onPatch={onPatch} />
      </InspectorSection>
      <InspectorSection
        sectionKey="agent:output"
        title="Output schema"
        badge={`${properties.length}`}
      >
        <SchemaEditor
          schema={node.output}
          issues={issues}
          onPatch={(output) => onPatch({ output })}
        />
      </InspectorSection>
      <InspectorSection sectionKey="agent:permissions" title="Permissions">
        <AgentPermissions node={node} issues={issues} onPatch={onPatch} />
      </InspectorSection>
      <InspectorSection sectionKey="agent:limits" title="Limits">
        <AgentLimits node={node} issues={issues} onPatch={onPatch} />
      </InspectorSection>
      <InspectorSection sectionKey="agent:workspace" title="Workspace">
        <p className="inspector-help" data-testid="inspector-workspace-note">
          Workspace is chosen when starting the workflow.
        </p>
      </InspectorSection>
      <InspectorSection sectionKey="agent:unsupported" title="Not implemented">
        <p className="inspector-help">
          Context reads, env passthrough, cliOptions, budgets and supervisor modes are not
          implemented in P1. The inspector does not enable them.
        </p>
      </InspectorSection>
    </>
  );
}
