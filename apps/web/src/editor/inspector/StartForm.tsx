import type { StartNode, StartWebhookConfig, WorkflowParam } from "@devchestra/schema";
import { Plus } from "lucide-react";
import { CheckboxField } from "./fields/fields.js";
import { ParamRow } from "./ParamRow.js";
import { PollingEditor } from "./PollingEditor.js";
import { InspectorSection } from "./Section.js";
import type { FormProps, PatchOf } from "./types.js";
import { WebhookMappingEditor } from "./WebhookMappingEditor.js";

function nextName(params: readonly WorkflowParam[]): string {
  const used = new Set(params.map((param) => param.name));
  let index = params.length + 1;
  while (used.has(`param${index}`)) index += 1;
  return `param${index}`;
}

/** Writes a mapping back into the webhook block. An empty mapping is dropped, because a present one is authoritative. */
function withMapping(
  webhook: StartWebhookConfig,
  mapping: Record<string, string> | undefined,
): StartWebhookConfig {
  return mapping === undefined || Object.keys(mapping).length === 0
    ? { enabled: webhook.enabled }
    : { enabled: webhook.enabled, paramMapping: mapping };
}

/** The mapping after one parameter is renamed (`to` set) or removed (`to` null). */
function remapParameter(
  mapping: Record<string, string>,
  from: string,
  to: string | null,
): Record<string, string> | undefined {
  const entries = Object.entries(mapping).flatMap(([name, path]): [string, string][] => {
    if (name !== from) return [[name, path]];
    return to === null ? [] : [[to, path]];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function StartForm({
  node,
  issues,
  onPatch,
  bodyMode = false,
  projectId,
}: FormProps<StartNode> & { bodyMode?: boolean; projectId?: string | undefined }) {
  if (bodyMode) {
    return (
      <InspectorSection sectionKey="start:parameters" title="Parameters" badge="0">
        <p className="inspector-help" data-testid="inspector-start-body-note">
          Body Start takes no parameters; parent inputs arrive via loop.parent.
        </p>
      </InspectorSection>
    );
  }
  const webhook = node.webhook;
  const webhookOn = webhook?.enabled === true;
  const mapping = webhook?.paramMapping;
  const polling = node.polling;
  const pollingOn = polling?.enabled === true;

  const addParam = (): void => {
    onPatch({
      params: [...node.params, { name: nextName(node.params), type: "string", required: false }],
    });
  };

  // A mapping is keyed by parameter name, so renaming or removing a parameter
  // moves or drops its entry in the same patch (one undo step, no stale key).
  const changeParam = (index: number, param: WorkflowParam): void => {
    const previous = node.params[index]?.name;
    const patch: PatchOf<StartNode> = {
      params: node.params.map((entry, at) => (at === index ? param : entry)),
    };
    if (
      webhook !== undefined &&
      mapping !== undefined &&
      previous !== undefined &&
      previous !== param.name &&
      Object.hasOwn(mapping, previous)
    ) {
      patch.webhook = withMapping(webhook, remapParameter(mapping, previous, param.name));
    }
    onPatch(patch);
  };

  const removeParam = (index: number): void => {
    const removed = node.params[index]?.name;
    const patch: PatchOf<StartNode> = { params: node.params.filter((_, at) => at !== index) };
    if (
      webhook !== undefined &&
      mapping !== undefined &&
      removed !== undefined &&
      Object.hasOwn(mapping, removed)
    ) {
      patch.webhook = withMapping(webhook, remapParameter(mapping, removed, null));
    }
    onPatch(patch);
  };

  return (
    <>
      <InspectorSection
        sectionKey="start:parameters"
        title="Parameters"
        badge={`${node.params.length}`}
      >
        <p className="inspector-help">
          Run inputs for this workflow. Blank defaults mean the parameter has no default.
        </p>
        {node.params.length === 0 ? (
          <p className="inspector-muted">No run parameters yet.</p>
        ) : (
          <div className="inspector-param-list">
            {node.params.map((param, index) => (
              <ParamRow
                // biome-ignore lint/suspicious/noArrayIndexKey: params have no stable id; ParamRow syncs its buffers from the prop on reorder
                key={index}
                index={index}
                param={param}
                issues={issues}
                onChange={(next) => changeParam(index, next)}
                onRemove={() => removeParam(index)}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn sm"
          data-testid="inspector-add-param"
          onClick={addParam}
        >
          <Plus size={13} aria-hidden="true" />
          Add parameter
        </button>
      </InspectorSection>

      <InspectorSection
        sectionKey="start:webhook"
        title="Webhook trigger"
        badge={webhookOn ? "On" : "Off"}
      >
        <CheckboxField
          id="inspector-start-webhook"
          label="Accept webhook triggers"
          hint="An armed trigger can start this workflow from an HTTP delivery."
          help="Arm and disarm from the editor header. This only declares support in the saved file. Manual runs are unaffected."
          checked={webhookOn}
          onChange={(checked) =>
            onPatch({ webhook: checked ? { ...webhook, enabled: true } : undefined })
          }
        />
        {webhookOn ? (
          <WebhookMappingEditor
            params={node.params}
            mapping={mapping ?? {}}
            issues={issues}
            onChange={(next) =>
              onPatch({ webhook: withMapping(webhook ?? { enabled: true }, next) })
            }
          />
        ) : null}
      </InspectorSection>

      <InspectorSection
        sectionKey="start:polling"
        title="Polling trigger"
        badge={pollingOn ? "On" : "Off"}
      >
        <CheckboxField
          id="inspector-start-polling"
          label="Accept polling triggers"
          hint="An armed trigger probes on a timer and starts a run when it finds work."
          help="Arm and disarm from the editor header. This only declares support in the saved file. Manual runs are unaffected."
          checked={pollingOn}
          onChange={(checked) =>
            onPatch({
              polling: checked
                ? {
                    enabled: true,
                    probe: { type: "shell", command: "" },
                    dedupe: true,
                    workspace: "project",
                  }
                : undefined,
            })
          }
        />
        {pollingOn && polling !== undefined ? (
          <PollingEditor
            nodeId={node.id}
            projectId={projectId}
            polling={polling}
            paramCount={node.params.length}
            issues={issues}
            onChange={(next) => onPatch({ polling: next })}
          />
        ) : null}
      </InspectorSection>
    </>
  );
}
