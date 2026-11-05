import { isRecord } from "@devchestra/core";
import type { AgentNode } from "@devchestra/schema";
import { AgentLimits } from "./AgentLimits.js";
import { AgentModelSection } from "./AgentModelSection.js";
import { AgentPermissions } from "./AgentPermissions.js";
import { AgentPrompt } from "./AgentPrompt.js";
import { AgentTools } from "./AgentTools.js";
import { ExpandableTextarea } from "./fields/ExpandableTextarea.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";
import { useEffectiveTiers } from "./model/useEffectiveTiers.js";
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
  const { clis } = useAvailableClis();
  const effective = useEffectiveTiers(projectId, node.tier !== undefined);
  // A tiered node has no single provider; its tools follow the tier's mapping on this machine.
  const resolvedCli = node.tier === undefined ? node.cli : effective.mappings?.[node.tier]?.ref.cli;
  const selected = clis.find((entry) => entry.id === resolvedCli);
  const providerHelpHref =
    projectId === undefined ? "/settings/providers" : `/p/${projectId}/settings/providers`;
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
          <AgentModelSection
            node={node}
            issues={issues}
            projectId={projectId}
            clis={clis}
            effective={effective}
            providerHelpHref={providerHelpHref}
            onPatch={onPatch}
          />
        </InspectorSection>
        <InspectorSection sectionKey="agent:tools" title="Tools">
          <AgentTools
            node={node}
            projectId={projectId}
            resolvedCli={resolvedCli}
            onPatch={onPatch}
          />
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
        <AgentModelSection
          node={node}
          issues={issues}
          projectId={projectId}
          clis={clis}
          effective={effective}
          providerHelpHref={providerHelpHref}
          onPatch={onPatch}
        />
      </InspectorSection>
      <InspectorSection sectionKey="agent:tools" title="Tools">
        <AgentTools node={node} projectId={projectId} resolvedCli={resolvedCli} onPatch={onPatch} />
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
