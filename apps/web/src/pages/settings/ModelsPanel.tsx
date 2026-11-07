import type { ModelRefDto, SettingsDocument, SettingsScopeValue } from "@devchestra/api";
import {
  type AgentCli,
  MODEL_TIER_LABELS,
  MODEL_TIERS,
  type ModelTierId,
  PROD_CLI_LABELS,
  PROD_CLIS,
} from "@devchestra/schema";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useParams } from "react-router-dom";
import { classifyError } from "../../api/client.js";
import {
  isSettingsConflict,
  useEffectiveSettings,
  useSaveSettings,
  useSettingsLayer,
} from "../../api/settings.js";
import { AgentModelPicker } from "../../editor/inspector/AgentModelPicker.js";
import { useCliModelCatalog } from "../../editor/inspector/model/useCliModelCatalog.js";
import { sourceLabel } from "../../editor/inspector/model/useEffectiveTiers.js";
import { ProviderIcon } from "../../ui/ProviderIcon.js";
import { InlineError } from "../../ui/states.js";
import "../../styles/settings-models.css";

type Draft = Partial<Record<ModelTierId, ModelRefDto>>;

const SCOPES: Record<
  SettingsScopeValue,
  { title: string; file: string; blurb: string; testId: string }
> = {
  local: {
    title: "This machine",
    file: ".devchestra/settings.local.json",
    blurb: "Only this machine uses it. Git ignores the file, and it wins over the shared one.",
    testId: "settings-scope-local",
  },
  project: {
    title: "Shared with the team",
    file: ".devchestra/settings.json",
    blurb: "Commit it to give everyone the same defaults. Any machine can override a tier.",
    testId: "settings-scope-project",
  },
};

function draftOf(document: SettingsDocument): Draft {
  const draft: Draft = {};
  for (const tier of MODEL_TIERS) {
    const ref = document.models?.[tier];
    if (ref !== undefined) draft[tier] = ref.model === undefined ? { cli: ref.cli } : { ...ref };
  }
  return draft;
}

function documentOf(draft: Draft): SettingsDocument {
  const models: NonNullable<SettingsDocument["models"]> = {};
  for (const tier of MODEL_TIERS) {
    const ref = draft[tier];
    if (ref !== undefined) models[tier] = ref;
  }
  return Object.keys(models).length === 0 ? { version: 1 } : { version: 1, models };
}

/** Canonical text of a draft, so "changed" means the saved file would differ. */
function signature(draft: Draft): string {
  return JSON.stringify(
    MODEL_TIERS.map((tier) => {
      const ref = draft[tier];
      return ref === undefined ? null : [ref.cli, ref.model ?? null];
    }),
  );
}

export function ModelsPanel() {
  const { pid = "" } = useParams();
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <h2>Model tiers</h2>
        <p className="faint">
          An agent node can name a tier (High, Medium or Low) instead of a fixed model. Each machine
          maps the tiers to the providers it has, so a committed workflow runs anywhere without
          editing. Settings never hold secrets.
        </p>
      </div>
      {pid === "" ? (
        <div className="note" role="status" data-testid="models-no-project">
          <span>Model tiers are set per project. Open a project, then come back to Settings.</span>
        </div>
      ) : (
        <>
          <EffectiveSummary projectId={pid} />
          <ScopeCard projectId={pid} scope="local" />
          <ScopeCard projectId={pid} scope="project" />
        </>
      )}
    </div>
  );
}

function ModelText({ cli, model }: { cli: AgentCli; model: string | undefined }) {
  return (
    <>
      <ProviderIcon cli={cli} size={14} />
      <span className="tier-result-value">
        {PROD_CLI_LABELS[cli]}
        <span className="faint">{model === undefined ? " · provider default" : ` · ${model}`}</span>
      </span>
    </>
  );
}

/** What a run on this machine would use for each tier, and which file supplied it. */
function EffectiveSummary({ projectId }: { projectId: string }) {
  const effective = useEffectiveSettings(projectId);
  const headingId = useId();
  return (
    <section className="card" aria-labelledby={headingId} data-testid="settings-effective">
      <div className="card-head">
        <h3 id={headingId} style={{ margin: 0, fontSize: 13 }}>
          Used on this machine
        </h3>
      </div>
      <div className="card-body">
        {effective.isPending ? (
          <div aria-busy="true" className="stack" style={{ gap: 8 }}>
            <div className="skeleton" style={{ width: "70%", height: 16 }} />
            <div className="skeleton" style={{ width: "60%", height: 16 }} />
            <div className="skeleton" style={{ width: "65%", height: 16 }} />
          </div>
        ) : null}
        {effective.isError ? (
          <InlineError
            message={`Couldn't read the tier settings. ${classifyError(effective.error).message}`}
          />
        ) : null}
        {effective.data === undefined ? null : (
          <ul className="tier-results" aria-label="Tier results on this machine">
            {effective.data.tiers.map(({ tier, mapping }) => (
              <li key={tier} className="tier-result" data-testid={`settings-effective-${tier}`}>
                <span className="tier-result-name">{MODEL_TIER_LABELS[tier]}</span>
                {mapping === null ? (
                  <>
                    <span className="tier-result-value faint">No provider chosen</span>
                    <span className="pill amber">
                      <TriangleAlert size={11} aria-hidden="true" /> Not set
                    </span>
                  </>
                ) : (
                  <>
                    <ModelText cli={mapping.ref.cli} model={mapping.ref.model} />
                    <span className="tier-result-source">{sourceLabel(mapping.source)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ScopeCard({ projectId, scope }: { projectId: string; scope: SettingsScopeValue }) {
  const layer = useSettingsLayer(projectId, scope);
  // Owned here, not by the form: a save swaps in a new ETag, which remounts the form.
  const save = useSaveSettings(projectId, scope);
  const meta = SCOPES[scope];
  const headingId = useId();
  return (
    <section
      className="card"
      aria-labelledby={headingId}
      data-testid={meta.testId}
      aria-busy={layer.isPending}
    >
      <div className="card-head tier-scope-head">
        <h3 id={headingId} style={{ margin: 0, fontSize: 13 }}>
          {meta.title}
        </h3>
        <span className="mono faint">{meta.file}</span>
      </div>
      <div className="card-body">
        <p className="faint tier-scope-blurb">{meta.blurb}</p>
        {layer.isPending ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="skeleton" style={{ width: "100%", height: 28 }} />
            <div className="skeleton" style={{ width: "100%", height: 28 }} />
            <div className="skeleton" style={{ width: "100%", height: 28 }} />
          </div>
        ) : null}
        {layer.isError ? (
          <div className="stack" style={{ gap: 8 }}>
            <InlineError
              message={`Couldn't load ${meta.file}. ${classifyError(layer.error).message}`}
            />
            <div>
              <button type="button" className="btn sm" onClick={() => void layer.refetch()}>
                Try again
              </button>
            </div>
          </div>
        ) : null}
        {layer.data === undefined ? null : (
          // Keyed by ETag: a save or reload swaps in the fresh file as the starting draft.
          <ScopeForm
            key={layer.data.etag}
            projectId={projectId}
            scope={scope}
            etag={layer.data.etag}
            document={layer.data.document}
            warnings={layer.data.warnings}
            save={save}
            onReload={() => {
              save.reset();
              void layer.refetch();
            }}
          />
        )}
      </div>
    </section>
  );
}

function ScopeForm({
  projectId,
  scope,
  etag,
  document,
  warnings,
  save,
  onReload,
}: {
  projectId: string;
  scope: SettingsScopeValue;
  etag: string;
  document: SettingsDocument;
  warnings: readonly string[];
  save: ReturnType<typeof useSaveSettings>;
  onReload(): void;
}) {
  const saved = draftOf(document);
  const [draft, setDraft] = useState<Draft>(saved);
  const dirty = signature(draft) !== signature(saved);
  const conflict = save.isError && isSettingsConflict(save.error);
  const meta = SCOPES[scope];

  const setTier = (tier: ModelTierId, ref: ModelRefDto | undefined) =>
    setDraft((current) => {
      const next = { ...current };
      if (ref === undefined) delete next[tier];
      else next[tier] = ref;
      return next;
    });

  return (
    <form
      className="stack"
      style={{ gap: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate({ document: documentOf(draft), etag });
      }}
    >
      <div className="tier-rows">
        {MODEL_TIERS.map((tier) => (
          <TierRow
            key={tier}
            projectId={projectId}
            scope={scope}
            tier={tier}
            value={draft[tier]}
            disabled={save.isPending}
            onChange={(ref) => setTier(tier, ref)}
          />
        ))}
      </div>
      {warnings.map((warning) => (
        <p key={warning} className="faint" role="note">
          {warning}
        </p>
      ))}
      {conflict ? (
        <div className="note amber" role="alert" data-testid={`${meta.testId}-conflict`}>
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            {meta.file} changed on disk since you opened it. Reload to see the current file; your
            edits here will be discarded.{" "}
            <button type="button" className="btn sm" onClick={onReload}>
              Reload
            </button>
          </span>
        </div>
      ) : save.isError ? (
        <InlineError message={`Couldn't save. ${classifyError(save.error).message}`} />
      ) : null}
      <div className="tier-actions">
        <span className="faint" role="status" data-testid={`${meta.testId}-status`}>
          {save.isPending ? "Saving…" : dirty ? "Unsaved changes" : save.isSuccess ? "Saved." : ""}
        </span>
        <button
          type="button"
          className="btn ghost"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setDraft(saved);
            save.reset();
          }}
        >
          Discard
        </button>
        <button
          type="submit"
          className="btn primary"
          data-testid={`${meta.testId}-save`}
          disabled={!dirty || save.isPending}
        >
          Save
        </button>
      </div>
    </form>
  );
}

function TierRow({
  projectId,
  scope,
  tier,
  value,
  disabled,
  onChange,
}: {
  projectId: string;
  scope: SettingsScopeValue;
  tier: ModelTierId;
  value: ModelRefDto | undefined;
  disabled: boolean;
  onChange(ref: ModelRefDto | undefined): void;
}) {
  const [open, setOpen] = useState(false);
  const selectId = useId();
  const cli = value?.cli;
  const { catalog, loading, error, refresh } = useCliModelCatalog({
    projectId,
    cli: cli ?? "claude-code",
    // Loads on mount, not on open, so a saved model id shows its name instead of "Custom".
    open: cli !== undefined,
  });
  const label = MODEL_TIER_LABELS[tier];
  const rowId = `${scope}-${tier}`;

  return (
    <div className="tier-row" data-testid={`settings-tier-${rowId}`}>
      <label className="tier-row-name" htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        className="input"
        data-testid={`settings-tier-cli-${rowId}`}
        aria-label={`${label} provider, ${SCOPES[scope].title}`}
        value={cli ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === "") onChange(undefined);
          // A model id belongs to one provider, so changing the provider drops it.
          else if (next !== cli) onChange({ cli: next as AgentCli });
        }}
      >
        <option value="">Not set</option>
        {PROD_CLIS.map((id) => (
          <option key={id} value={id}>
            {PROD_CLI_LABELS[id]}
          </option>
        ))}
      </select>
      {cli === undefined ? (
        <span className="tier-row-empty faint">Choose a provider to pick a model.</span>
      ) : (
        <div className="tier-row-model" data-testid={`settings-tier-model-${rowId}`}>
          <AgentModelPicker
            id={`settings-tier-model-${rowId}`}
            label={`${label} model, ${SCOPES[scope].title}`}
            cli={cli}
            cliLabel={PROD_CLI_LABELS[cli]}
            value={value?.model}
            catalog={catalog}
            loading={loading}
            error={error}
            projectId={projectId}
            open={open}
            disabled={disabled}
            onOpenChange={setOpen}
            onSelect={(model) => onChange({ cli, model })}
            onUseDefault={() => onChange({ cli })}
            onRefresh={refresh}
          />
        </div>
      )}
    </div>
  );
}
