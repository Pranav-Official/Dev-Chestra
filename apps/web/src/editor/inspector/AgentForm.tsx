import { isRecord } from "@devchestra/core";
import type { AgentNode } from "@devchestra/schema";
import { AgentLimits } from "./AgentLimits.js";
import { AgentModelField } from "./AgentModelField.js";
import { AgentPermissions } from "./AgentPermissions.js";
import { AgentPrompt } from "./AgentPrompt.js";
import { AgentTools } from "./AgentTools.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";
import { ProviderChips } from "./ProviderChips.js";
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
      <InspectorSection sectionKey="agent:prompt" title="Prompt">
        <AgentPrompt node={node} issues={issues} onPatch={onPatch} />
      </InspectorSection>
      <InspectorSection sectionKey="agent:agent" title="Model">
        <div className="inspector-stack">
          <Field id="inspector-agent-cli" label="Provider" required error={cliIssue}>
            <ProviderChips
              clis={clis}
              value={node.cli}
              invalid={cliIssue !== null}
              describedBy={describedBy("inspector-agent-cli", undefined, cliIssue)}
              onSelect={(next) => {
                if (next !== node.cli) onPatch({ cli: next, model: undefined });
              }}
            />
            {selected?.enabled === false ? (
              <p className="inspector-help" role="status" data-testid="inspector-agent-cli-off">
                {selected.label} is turned off. Runs that use this node are blocked. Turn it on in{" "}
                <a
                  href={
                    projectId === undefined
                      ? "/settings/providers"
                      : `/p/${projectId}/settings/providers`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Settings
                </a>
                , or pick another provider.
              </p>
            ) : null}
          </Field>
          <AgentModelField
            key={`${node.id}:${node.cli}`}
            node={node}
            projectId={projectId}
            issues={issues}
            onPatch={onPatch}
          />
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="agent:tools" title="Tools">
        <AgentTools node={node} projectId={projectId} onPatch={onPatch} />
      </InspectorSection>
      <InspectorSection sectionKey="agent:output" title="Output" badge={`${properties.length}`}>
        <SchemaEditor
          schema={node.output}
          issues={issues}
          onPatch={(output) => onPatch({ output })}
        />
      </InspectorSection>
      <InspectorSection sectionKey="agent:permissions" title="Permissions" defaultOpen={false}>
        <AgentPermissions node={node} issues={issues} onPatch={onPatch} />
      </InspectorSection>
      <InspectorSection sectionKey="agent:limits" title="Limits" defaultOpen={false}>
        <AgentLimits node={node} issues={issues} onPatch={onPatch} />
      </InspectorSection>
      {selected === undefined ? null : (
        <p className="inspector-footnote" role="note">
          Permissions are advisory: {selected.label} runs without an OS sandbox.
        </p>
      )}
      <p className="inspector-footnote" data-testid="inspector-workspace-note">
        Workspace is chosen when starting the workflow.
      </p>
    </>
  );
}
