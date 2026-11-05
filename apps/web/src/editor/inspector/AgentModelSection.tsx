import type { AgentCli, AgentNode, Issue, ModelTierId } from "@devchestra/schema";
import { MODEL_TIER_LABELS, MODEL_TIERS, PROD_CLI_LABELS } from "@devchestra/schema";
import { TriangleAlert } from "lucide-react";
import { ProviderIcon } from "../../ui/ProviderIcon.js";
import { AgentModelField } from "./AgentModelField.js";
import { ChoiceChips } from "./ChoiceChips.js";
import { describedBy, Field } from "./fields/fields.js";
import { fieldIssue } from "./issues.js";
import type { AvailableCli } from "./model/useAvailableClis.js";
import { type EffectiveTiers, sourceLabel } from "./model/useEffectiveTiers.js";
import { ProviderChips } from "./ProviderChips.js";
import type { PatchOf } from "./types.js";

type Source = "specific" | "tier";

const SOURCE_OPTIONS = [
  { id: "specific", label: "Specific model" },
  { id: "tier", label: "Model tier" },
] as const;

const SOURCE_HELP =
  "A model tier uses the provider and model each machine sets in Project settings, so a shared workflow runs on any machine without editing it.";

const DEFAULT_TIER: ModelTierId = "medium";

export function projectSettingsHref(projectId: string | undefined): string {
  return projectId === undefined ? "/settings/models" : `/p/${projectId}/settings/models`;
}

function modelText(model: string | undefined): string {
  return model === undefined ? "provider default model" : model;
}

/** What the picked tier resolves to here, or why that is not known. */
function TierPreview({
  tier,
  projectId,
  effective,
}: {
  tier: ModelTierId;
  projectId: string | undefined;
  effective: EffectiveTiers;
}) {
  if (projectId === undefined) {
    return (
      <p className="inspector-muted" data-testid="inspector-tier-noproject">
        Open this workflow from a project to see what this tier resolves to.
      </p>
    );
  }
  if (effective.loading) {
    return (
      <p className="inspector-muted" role="status" data-testid="inspector-tier-loading">
        Checking this machine…
      </p>
    );
  }
  if (effective.mappings === null) {
    return (
      <p className="inspector-muted" role="status" data-testid="inspector-tier-unknown">
        Couldn&apos;t read this machine&apos;s tier settings.
      </p>
    );
  }
  const mapping = effective.mappings[tier];
  if (mapping === null) {
    return (
      <div className="inspector-note amber" role="status" data-testid="inspector-tier-unset">
        <TriangleAlert size={14} aria-hidden="true" />
        <div>
          <b>{MODEL_TIER_LABELS[tier]} isn&apos;t set on this machine.</b>
          <p>
            A run that uses this node stops before it starts. Choose a provider for it in{" "}
            <a href={projectSettingsHref(projectId)} target="_blank" rel="noopener noreferrer">
              Project settings
            </a>
            .
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="tier-preview" role="status" data-testid="inspector-tier-resolved">
      <ProviderIcon cli={mapping.ref.cli} size={14} />
      <span className="tier-preview-value">
        {`${PROD_CLI_LABELS[mapping.ref.cli]} · ${modelText(mapping.ref.model)}`}
      </span>
      <span className="tier-preview-source">{sourceLabel(mapping.source)}</span>
    </div>
  );
}

export function AgentModelSection({
  node,
  issues,
  projectId,
  clis,
  effective,
  onPatch,
  providerHelpHref,
}: {
  node: AgentNode;
  issues: readonly Issue[];
  projectId: string | undefined;
  clis: AvailableCli[];
  /** What each tier resolves to on this machine; owned by the form so the tools list can share it. */
  effective: EffectiveTiers;
  onPatch: (patch: PatchOf<AgentNode>) => void;
  /** Where "turn it on in Settings" points. */
  providerHelpHref: string;
}) {
  const cliIssue = fieldIssue(issues, "/cli");
  const tierIssue = fieldIssue(issues, "/tier");
  const tiered = node.tier !== undefined;
  const selected = clis.find((entry) => entry.id === node.cli);
  const source: Source = tiered ? "tier" : "specific";

  const chooseSource = (next: Source) => {
    if (next === source) return;
    if (next === "tier") {
      onPatch({ tier: DEFAULT_TIER, cli: undefined, model: undefined });
      return;
    }
    // Back to a fixed model: start from what the tier resolved to here, so the node keeps
    // working the way it did a moment ago.
    const mapped = node.tier === undefined ? null : effective.mappings?.[node.tier];
    const fallback = clis.find((entry) => entry.enabled)?.id ?? clis[0]?.id ?? "claude-code";
    const cli: AgentCli = mapped?.ref.cli ?? fallback;
    onPatch({ tier: undefined, cli, model: mapped?.ref.model });
  };

  const tierOptions = MODEL_TIERS.map((tier) => ({
    id: tier,
    label: MODEL_TIER_LABELS[tier],
    tag: effective.mappings !== null && effective.mappings[tier] === null ? "Not set" : undefined,
  }));

  return (
    <div className="inspector-stack">
      <Field id="inspector-agent-source" label="Model source" help={SOURCE_HELP}>
        <ChoiceChips
          label="Model source"
          options={SOURCE_OPTIONS}
          value={source}
          testId="inspector-agent-source"
          onSelect={chooseSource}
        />
      </Field>
      {tiered ? (
        <>
          <Field id="inspector-agent-tier" label="Tier" required error={tierIssue}>
            <ChoiceChips
              label="Tier"
              options={tierOptions}
              value={node.tier}
              columns={3}
              testId="inspector-agent-tier"
              describedBy={describedBy("inspector-agent-tier", undefined, tierIssue)}
              onSelect={(tier) => onPatch({ tier })}
            />
          </Field>
          {node.tier === undefined ? null : (
            <TierPreview tier={node.tier} projectId={projectId} effective={effective} />
          )}
        </>
      ) : (
        <>
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
                <a href={providerHelpHref} target="_blank" rel="noopener noreferrer">
                  Settings
                </a>
                , or pick another provider.
              </p>
            ) : null}
          </Field>
          {node.cli === undefined ? null : (
            <AgentModelField
              key={`${node.id}:${node.cli}`}
              node={{ id: node.id, cli: node.cli, model: node.model }}
              projectId={projectId}
              issues={issues}
              onPatch={onPatch}
            />
          )}
        </>
      )}
    </div>
  );
}
