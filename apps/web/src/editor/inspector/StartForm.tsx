import type { StartNode, WorkflowParam } from "@devchestra/schema";
import { Plus } from "lucide-react";
import { ParamRow } from "./ParamRow.js";
import { InspectorSection } from "./Section.js";
import type { FormProps } from "./types.js";

function nextName(params: readonly WorkflowParam[]): string {
  const used = new Set(params.map((param) => param.name));
  let index = params.length + 1;
  while (used.has(`param${index}`)) index += 1;
  return `param${index}`;
}

export function StartForm({
  node,
  issues,
  onPatch,
  bodyMode = false,
}: FormProps<StartNode> & { bodyMode?: boolean }) {
  if (bodyMode) {
    return (
      <InspectorSection sectionKey="start:parameters" title="Parameters" badge="0">
        <p className="inspector-help" data-testid="inspector-start-body-note">
          Body Start takes no parameters; parent inputs arrive via loop.parent.
        </p>
      </InspectorSection>
    );
  }
  const addParam = (): void => {
    onPatch({
      params: [...node.params, { name: nextName(node.params), type: "string", required: false }],
    });
  };

  const changeParam = (index: number, param: WorkflowParam): void => {
    onPatch({ params: node.params.map((entry, at) => (at === index ? param : entry)) });
  };

  const removeParam = (index: number): void => {
    onPatch({ params: node.params.filter((_, at) => at !== index) });
  };

  return (
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
      <button type="button" className="btn sm" data-testid="inspector-add-param" onClick={addParam}>
        <Plus size={13} aria-hidden="true" />
        Add parameter
      </button>
    </InspectorSection>
  );
}
