import type { AgentCli, AgentNode, Issue } from "@devchestra/schema";
import { PROD_CLI_LABELS } from "@devchestra/schema";
import { useState } from "react";
import { AgentModelPicker } from "./AgentModelPicker.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import { useAvailableClis } from "./model/useAvailableClis.js";
import { useCliModelCatalog } from "./model/useCliModelCatalog.js";
import type { PatchOf } from "./types.js";

const HELP = "Optional. Leave on the default to use the provider's own model.";

/** The cli/model slice AgentModelField edits. Widened from AgentNode so the
 * polling probe (which is not a node) can reuse the same picker. */
export interface AgentModelValue {
  id: string;
  cli: AgentCli;
  model?: string | undefined;
}

export type AgentModelPatch = Pick<PatchOf<AgentNode>, "cli" | "model">;

export function AgentModelField({
  node,
  projectId,
  issues,
  onPatch,
}: {
  node: AgentModelValue;
  projectId?: string | undefined;
  issues: readonly Issue[];
  onPatch: (patch: AgentModelPatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const modelIssue = fieldIssue(issues, "/model");
  const { clis } = useAvailableClis();
  const cliLabel = clis.find((entry) => entry.id === node.cli)?.label ?? PROD_CLI_LABELS[node.cli];
  const { catalog, loading, error, refresh } = useCliModelCatalog({
    projectId,
    cli: node.cli,
    nodeId: node.id,
    open,
  });

  return (
    <Field id="inspector-agent-model" label="Model" help={HELP} error={modelIssue}>
      <AgentModelPicker
        id="inspector-agent-model"
        cli={node.cli}
        cliLabel={cliLabel}
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
