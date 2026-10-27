import type { AgentNode, Issue } from "@relay/schema";
import { useState } from "react";
import { AgentModelPicker } from "./AgentModelPicker.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useCliModelCatalog } from "./model/useCliModelCatalog.js";
import type { PatchOf } from "./types.js";

const HELP =
  "Optional override from the selected CLI's runtime catalog. No override uses the CLI default. Advertised models do not prove account entitlement.";

export function AgentModelField({
  node,
  projectId,
  issues,
  onPatch,
}: {
  node: AgentNode;
  projectId?: string | undefined;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<AgentNode>) => void;
}) {
  const [open, setOpen] = useState(false);
  const modelIssue = fieldIssue(issues, "/model");
  const { catalog, loading, error, refresh } = useCliModelCatalog({
    projectId,
    cli: node.cli,
    nodeId: node.id,
    open,
  });

  return (
    <Field id="inspector-agent-model" label="Model (optional)" help={HELP} error={modelIssue}>
      <AgentModelPicker
        id="inspector-agent-model"
        value={node.model}
        catalog={catalog}
        loading={loading}
        error={error}
        projectId={projectId}
        open={open}
        describedBy={describedBy("inspector-agent-model", HELP, modelIssue)}
        invalid={modelIssue !== null}
        onOpenChange={setOpen}
        onSelect={(model) => onPatch({ model })}
        onUseDefault={() => onPatch({ model: undefined })}
        onRefresh={refresh}
      />
    </Field>
  );
}
