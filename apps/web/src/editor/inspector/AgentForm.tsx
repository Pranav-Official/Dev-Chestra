import { isRecord } from "@devchestra/core";
import type { AgentNode } from "@devchestra/schema";
import { AgentLimits } from "./AgentLimits.js";
import { AgentModelField } from "./AgentModelField.js";
import { AgentPermissions } from "./AgentPermissions.js";
import { AgentPrompt } from "./AgentPrompt.js";
import { AgentTools } from "./AgentTools.js";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";
import { ProviderChips } from "./ProviderChips.js";
import { InspectorSection } from "./Section.js";
import { SchemaEditor } from "./schema/SchemaEditor.js";
import type { FormProps } from "./types.js";

function probeFailure(
  issues: readonly { code: string; severity: string; message: string }[],
): string | null {
  const found = issues.filter(
    (issue) => issue.code === "E_POLL_PROBE" && issue.severity === "error",
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

function ProbePrompt({
  node,
  issues,
  onPatch,
}: {
  node: AgentNode;
  issues: FormProps<AgentNode>["issues"];
  onPatch: FormProps<AgentNode>["onPatch"];
}) {
  const promptIssue = fieldIssue(issues, "/prompt");
  const help = "A contract preamble is prepended automatically. {{ }} variables are not available.";
  const id = "inspector-agent-prompt";
  return (
    <div className="inspector-stack">
      <Field id={id} label="Prompt" required help={help} error={promptIssue}>
        <ExpandableTextarea
          id={id}
          label="Prompt"
          value={node.prompt ?? ""}
          onCommit={(next) => onPatch({ prompt: next })}
          mode="none"
          nodeId={node.id}
          field="prompt"
          textareaTestId={id}
          rows={6}
          error={promptIssue}
          help={help}
          describedBy={describedBy(id, undefined, promptIssue)}
        />
      </Field>
    </div>
  );
}

export function AgentForm({
  node,
  issues,
  onPatch,
  projectId,
  probeMode = false,
}: FormProps<AgentNode> & { projectId?: string | undefined; probeMode?: boolean }) {
  const cliIssue = fieldIssue(issues, "/cli");
  const { clis } = useAvailableClis();
  const selected = clis.find((entry) => entry.id === node.cli);
  const properties = isRecord(node.output?.properties) ? Object.keys(node.output.properties) : [];
  const failure = probeMode ? probeFailure(issues) : null;

  if (probeMode) {
    return (
      <>
        {failure === null ? null : (
          <p className="inspector-error" role="alert" data-testid="inspector-probe-error">
            {failure}
          </p>
        )}
        <InspectorSection sectionKey="agent:prompt" title="Prompt">
          <ProbePrompt node={node} issues={issues} onPatch={onPatch} />
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
        <InspectorSection sectionKey="agent:output" title="Output">
          <p className="inspector-help" role="note">
            The poll result format is generated for you.
          </p>
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
      </>
    );
  }

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
