import type { Edge } from "@relay/schema";
import {
  DECISION_MODEL_PATTERN,
  DECISION_PROVIDER_LABELS,
  DECISION_PROVIDERS,
  DECISION_UNCERTAIN_HANDLE,
  type DecisionNode,
  decisionHandles,
  HANDLE_ID_PATTERN,
} from "@relay/schema";
import { Plus, Trash2 } from "lucide-react";
import {
  addDecisionBranch,
  addDecisionLevel,
  addDecisionOption,
  defaultDecisionMode,
  removeDecisionBranch,
  removeDecisionLevel,
  removeDecisionOption,
  renameDecisionBranch,
  setDecisionOptionBranch,
  updateDecisionBand,
  updateDecisionLevel,
  updateDecisionOption,
} from "../model/routing.js";
import { useBufferFlag } from "./BufferContext.js";
import {
  type DecisionReadiness,
  DecisionTester,
  type DecisionTestRunner,
} from "./DecisionTester.js";
import { describedBy, Field } from "./fields/fields.js";
import { useBufferedHandle } from "./fields/useBufferedHandle.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { containingIssue, fieldIssue } from "./issues.js";
import { InspectorSection } from "./Section.js";
import type { RoutingFormProps } from "./types.js";
import { useDecisionProviders } from "./useDecisionProviders.js";

function edgeCount(edges: readonly Edge[], endpoint: string): number {
  return edges.filter((edge) => edge.from === endpoint || edge.to === endpoint).length;
}

function ProviderReadiness({ node }: { node: DecisionNode }) {
  const { providers, loading, failed } = useDecisionProviders();
  if (loading) {
    return (
      <p className="faint" data-testid="decision-provider-loading">
        Checking provider readiness…
      </p>
    );
  }
  const entry = providers.find((provider) => provider.id === node.provider);
  if (failed || entry === undefined || entry.unknown) {
    return (
      <p className="inspector-help" data-testid="decision-provider-unknown">
        Could not check provider readiness. The tester will report missing configuration.
      </p>
    );
  }
  if (entry.ready) {
    return (
      <p className="inspector-help" data-testid="decision-provider-ready">
        {entry.label} is ready.
      </p>
    );
  }
  return (
    <p className="inspector-error" role="alert" data-testid="decision-provider-missing">
      {entry.label} is not ready.
      {entry.missing.length === 0 ? null : (
        <span>
          {" "}
          Missing: <span className="mono">{entry.missing.join(", ")}</span>. Set{" "}
          {entry.missing.length === 1 ? "it" : "them"} in <span className="mono">.env</span>.
        </span>
      )}
    </p>
  );
}

function decisionReadiness(
  providers: { id: string; ready: boolean; missing: string[]; unknown: boolean }[],
  providerId: string,
): DecisionReadiness {
  const entry = providers.find((provider) => provider.id === providerId);
  if (entry === undefined || entry.unknown) return { ready: false, missing: [], unknown: true };
  return { ready: entry.ready, missing: entry.missing, unknown: false };
}

function ThresholdInput({
  node,
  field,
  label,
  help,
  issues,
  onPatch,
}: {
  node: DecisionNode;
  field: "trueAt" | "falseAt";
  label: string;
  help: string;
  issues: Parameters<typeof fieldIssue>[0];
  onPatch: RoutingFormProps<DecisionNode>["onPatch"];
}) {
  const value = node.mode.kind === "boolean" ? node.mode[field] : undefined;
  const buffered = useBufferedNumber(value, {
    label,
    min: 0,
    max: 1,
    integer: false,
    allowEmpty: true,
    onCommit: (next) => {
      if (node.mode.kind !== "boolean") return;
      onPatch({ mode: { ...node.mode, [field]: next } });
    },
    bufferKey: `decision.${node.id}.mode.${field}`,
  });
  if (node.mode.kind !== "boolean") return null;
  const issue = fieldIssue(issues, `/mode/${field}`) ?? containingIssue(issues, "/mode/threshold");
  const error = buffered.localError ?? issue;
  const id = `decision-${field}`;
  return (
    <Field id={id} label={`${label} (0–1, blank is 0.5)`} help={help} error={error}>
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="decimal"
        placeholder="0.5"
        value={buffered.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => buffered.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function BranchIdInput({
  node,
  branchId,
  index,
  kind,
  edges,
  onRoutingChange,
}: {
  node: DecisionNode;
  branchId: string;
  index: number;
  kind: "branch" | "band";
  edges: readonly Edge[];
  onRoutingChange: RoutingFormProps<DecisionNode>["onRoutingChange"];
}) {
  const committed = useBufferedHandle(
    branchId,
    (next) => {
      if (!HANDLE_ID_PATTERN.test(next)) {
        return "Handle ids must start with a letter or digit and use only letters, digits, underscores or hyphens.";
      }
      if (next === DECISION_UNCERTAIN_HANDLE) {
        return `'${DECISION_UNCERTAIN_HANDLE}' is reserved for the uncertain route.`;
      }
      const ids =
        node.mode.kind === "choice"
          ? node.mode.branches.map((branch) => branch.id)
          : node.mode.kind === "score"
            ? node.mode.bands.map((band) => band.id)
            : [];
      if (next !== branchId && ids.includes(next)) return `Handle '${next}' is already used.`;
      if (next !== branchId && edgeCount(edges, `${node.id}.${branchId}`) > 0) {
        return "This handle is connected. Disconnect its edge before renaming.";
      }
      return null;
    },
    (next) => {
      if (next === branchId) return;
      if (node.mode.kind === "choice") {
        const updated = renameDecisionBranch(node, branchId, next);
        if (updated !== null) onRoutingChange({ mode: updated.mode });
      } else if (node.mode.kind === "score") {
        const updated = updateDecisionBand(node, branchId, { id: next });
        if (updated !== null) onRoutingChange({ mode: updated.mode });
      }
    },
    `decision.${node.id}.${kind}.${branchId}.id`,
  );
  const id = `decision-${kind}-${index}-id`;
  return (
    <Field
      id={id}
      label="Handle id"
      required
      help="Edge endpoints use decisionId.handleId. Renaming is blocked while connected."
      error={committed.localError}
    >
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        value={committed.text}
        aria-invalid={committed.localError ? true : undefined}
        aria-describedby={describedBy(id, undefined, committed.localError)}
        onChange={(event) => committed.onChange(event.currentTarget.value)}
        onBlur={committed.onBlur}
        onKeyDown={committed.onKeyDown}
      />
    </Field>
  );
}

function ChoiceEditor({
  node,
  issues,
  edges,
  onRoutingChange,
}: {
  node: DecisionNode;
  issues: Parameters<typeof containingIssue>[0];
  edges: readonly Edge[];
  onRoutingChange: RoutingFormProps<DecisionNode>["onRoutingChange"];
}) {
  const mode = node.mode;
  const optionsIssue = containingIssue(issues, "/mode/options");
  const branchesIssue = containingIssue(issues, "/mode/branches");
  useBufferFlag("decision.options", optionsIssue);
  useBufferFlag("decision.branches", branchesIssue);
  if (mode.kind !== "choice") return null;
  return (
    <div className="inspector-stack">
      <p className="inspector-help">
        One row per answer option. Every option must sit in exactly one branch below; adding an
        option puts it in the first branch, removing a branch moves its options to the first
        remaining branch.
      </p>
      {mode.options.map((option, index) => {
        const valueIssue = fieldIssue(issues, `/mode/options/${index}/value`);
        const currentBranch =
          mode.branches.find((branch) => branch.values.includes(option.value))?.id ?? "";
        return (
          <fieldset
            className="inspector-schema-row"
            key={option.value}
            data-testid={`decision-option-${index}`}
          >
            <legend className="sr-only">Choice option {index + 1}</legend>
            <div className="inspector-row-head">
              <span className="inspector-row-title">Option {index + 1}</span>
              <button
                type="button"
                className="btn ghost sm danger"
                data-testid={`decision-option-${index}-remove`}
                aria-label={`Remove option ${index + 1}`}
                disabled={mode.options.length <= 1}
                onClick={() => {
                  const updated = removeDecisionOption(node, option.value);
                  if (updated !== null) onRoutingChange({ mode: updated.mode });
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
            <OptionValueInput
              node={node}
              value={option.value}
              index={index}
              issue={valueIssue}
              onRoutingChange={onRoutingChange}
            />
            <Field id={`decision-option-${index}-description`} label="Description (optional)">
              <input
                id={`decision-option-${index}-description`}
                className="inspector-input"
                data-testid={`decision-option-${index}-description`}
                type="text"
                value={option.description ?? ""}
                placeholder={option.value}
                maxLength={500}
                onChange={(event) => {
                  const updated = updateDecisionOption(node, option.value, {
                    description: event.currentTarget.value,
                  });
                  if (updated !== null) onRoutingChange({ mode: updated.mode });
                }}
              />
            </Field>
            <Field
              id={`decision-option-${index}-branch`}
              label="Branch"
              help="The route taken when the model picks this option."
            >
              <select
                id={`decision-option-${index}-branch`}
                className="inspector-input"
                data-testid={`decision-option-${index}-branch`}
                value={currentBranch}
                onChange={(event) => {
                  const updated = setDecisionOptionBranch(
                    node,
                    option.value,
                    event.currentTarget.value,
                  );
                  if (updated !== null) onRoutingChange({ mode: updated.mode });
                }}
              >
                {mode.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.id}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>
        );
      })}
      {optionsIssue ? (
        <p className="inspector-error" role="alert" data-testid="decision-options-error">
          {optionsIssue}
        </p>
      ) : null}
      <div className="inspector-inline">
        <button
          type="button"
          className="btn sm"
          data-testid="decision-option-add"
          disabled={mode.options.length >= 255}
          onClick={() => {
            const updated = addDecisionOption(node);
            if (updated !== null) onRoutingChange({ mode: updated.mode });
          }}
        >
          <Plus size={13} aria-hidden="true" />
          Add option
        </button>
      </div>
      <p className="inspector-help">Branches route the run. The uncertain handle is separate.</p>
      {mode.branches.map((branch, index) => {
        const connected = edgeCount(edges, `${node.id}.${branch.id}`);
        return (
          <fieldset
            className="inspector-schema-row"
            key={branch.id}
            data-testid={`decision-branch-${index}`}
          >
            <legend className="sr-only">Branch {index + 1}</legend>
            <div className="inspector-row-head">
              <span className="inspector-row-title">Branch {index + 1}</span>
              <span className="faint">
                {connected} connection{connected === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className="btn ghost sm danger"
                data-testid={`decision-branch-${index}-remove`}
                aria-label={`Remove branch ${index + 1}`}
                disabled={mode.branches.length <= 1}
                onClick={() => {
                  const updated = removeDecisionBranch(node, branch.id);
                  if (updated === null) return;
                  const removed = edges
                    .filter((edge) => edge.from === `${node.id}.${branch.id}`)
                    .map((edge) => edge.id);
                  onRoutingChange({ mode: updated.mode }, removed);
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
            <BranchIdInput
              node={node}
              branchId={branch.id}
              index={index}
              kind="branch"
              edges={edges}
              onRoutingChange={onRoutingChange}
            />
            <p className="inspector-help" data-testid={`decision-branch-${index}-values`}>
              Options:{" "}
              {branch.values.length === 0 ? (
                <span className="faint">none (this route never fires)</span>
              ) : (
                branch.values.map((value) => (
                  <span key={value} className="mono" style={{ marginRight: 6 }}>
                    {value}
                  </span>
                ))
              )}
            </p>
          </fieldset>
        );
      })}
      {branchesIssue ? (
        <p className="inspector-error" role="alert" data-testid="decision-branches-error">
          {branchesIssue}
        </p>
      ) : null}
      <div className="inspector-inline">
        <button
          type="button"
          className="btn sm"
          data-testid="decision-branch-add"
          onClick={() => {
            const updated = addDecisionBranch(node);
            if (updated !== null) onRoutingChange({ mode: updated.mode });
          }}
        >
          <Plus size={13} aria-hidden="true" />
          Add branch
        </button>
      </div>
    </div>
  );
}

function OptionValueInput({
  node,
  value,
  index,
  issue,
  onRoutingChange,
}: {
  node: DecisionNode;
  value: string;
  index: number;
  issue: string | null;
  onRoutingChange: RoutingFormProps<DecisionNode>["onRoutingChange"];
}) {
  const mode = node.mode;
  const options = mode.kind === "choice" ? mode.options : [];
  const committed = useBufferedText(
    value,
    (next) => {
      if (next.length < 1 || next.length > 100) return "Option values must be 1–100 characters.";
      if (next !== value && options.some((option) => option.value === next)) {
        return `Option '${next}' is already used.`;
      }
      return null;
    },
    (next) => {
      if (next === value) return;
      const updated = updateDecisionOption(node, value, { value: next });
      if (updated !== null) onRoutingChange({ mode: updated.mode });
    },
    `decision.${node.id}.option.${index}.value`,
  );
  const error = committed.localError ?? issue;
  const id = `decision-option-${index}-value`;
  return (
    <Field id={id} label="Option value" required error={error}>
      <input
        id={id}
        className="inspector-input mono"
        data-testid={id}
        type="text"
        value={committed.text}
        maxLength={100}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => committed.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function ScoreEditor({
  node,
  issues,
  edges,
  onRoutingChange,
}: {
  node: DecisionNode;
  issues: Parameters<typeof containingIssue>[0];
  edges: readonly Edge[];
  onRoutingChange: RoutingFormProps<DecisionNode>["onRoutingChange"];
}) {
  const mode = node.mode;
  const levelsIssue = containingIssue(issues, "/mode/levels");
  const bandsIssue = containingIssue(issues, "/mode/bands");
  useBufferFlag("decision.levels", levelsIssue);
  useBufferFlag("decision.bands", bandsIssue);
  if (mode.kind !== "score") return null;
  return (
    <div className="inspector-stack">
      <p className="inspector-help">
        Levels are ordered lowest first; score 0 is the lowest level. Adding or removing a level
        resets bands to one band per level.
      </p>
      {mode.levels.map((level, index) => (
        <LevelRow
          key={level.label}
          node={node}
          label={level.label}
          description={level.description}
          index={index}
          canRemove={mode.levels.length > 2}
          levelIssue={fieldIssue(issues, `/mode/levels/${index}/label`)}
          onRoutingChange={onRoutingChange}
        />
      ))}
      {levelsIssue ? (
        <p className="inspector-error" role="alert" data-testid="decision-levels-error">
          {levelsIssue}
        </p>
      ) : null}
      <div className="inspector-inline">
        <button
          type="button"
          className="btn sm"
          data-testid="decision-level-add"
          disabled={mode.levels.length >= 10}
          onClick={() => {
            const updated = addDecisionLevel(node);
            if (updated !== null) onRoutingChange({ mode: updated.mode });
          }}
        >
          <Plus size={13} aria-hidden="true" />
          Add level
        </button>
      </div>
      <p className="inspector-help">
        Bands route the run: the first band with score ≥ atLeast wins. atLeast must strictly
        decrease; the last band is the floor and catches everything below it.
      </p>
      {mode.bands.map((band, index) => {
        const isFloor = index === mode.bands.length - 1;
        return (
          <fieldset
            className="inspector-schema-row"
            key={band.id}
            data-testid={`decision-band-${index}`}
          >
            <legend className="sr-only">Band {index + 1}</legend>
            <div className="inspector-row-head">
              <span className="inspector-row-title">
                {isFloor ? "Band (floor)" : `Band ${index + 1}`}
              </span>
            </div>
            <BranchIdInput
              node={node}
              branchId={band.id}
              index={index}
              kind="band"
              edges={edges}
              onRoutingChange={onRoutingChange}
            />
            {isFloor ? (
              <p className="inspector-help">
                Floor band: catches every score below the band above. It cannot take an atLeast.
              </p>
            ) : (
              <BandAtLeastInput
                node={node}
                bandId={band.id}
                atLeast={band.atLeast}
                index={index}
                max={mode.levels.length - 1}
                issue={fieldIssue(issues, `/mode/bands/${index}/atLeast`)}
                onRoutingChange={onRoutingChange}
              />
            )}
          </fieldset>
        );
      })}
      {bandsIssue ? (
        <p className="inspector-error" role="alert" data-testid="decision-bands-error">
          {bandsIssue}
        </p>
      ) : null}
    </div>
  );
}

function LevelRow({
  node,
  label,
  description,
  index,
  canRemove,
  levelIssue,
  onRoutingChange,
}: {
  node: DecisionNode;
  label: string;
  description: string | undefined;
  index: number;
  canRemove: boolean;
  levelIssue: string | null;
  onRoutingChange: RoutingFormProps<DecisionNode>["onRoutingChange"];
}) {
  const mode = node.mode;
  const levels = mode.kind === "score" ? mode.levels : [];
  const committed = useBufferedText(
    label,
    (next) => {
      if (next.length === 0) return "Level labels must be non-empty.";
      if (next !== label && levels.some((level) => level.label === next)) {
        return `Level '${next}' is already used.`;
      }
      return null;
    },
    (next) => {
      if (next === label) return;
      const updated = updateDecisionLevel(node, label, { label: next });
      if (updated !== null) onRoutingChange({ mode: updated.mode });
    },
    `decision.${node.id}.level.${index}.label`,
  );
  const error = committed.localError ?? levelIssue;
  const id = `decision-level-${index}-label`;
  return (
    <div className="inspector-schema-row" data-testid={`decision-level-${index}`}>
      <div className="inspector-row-head">
        <span className="inspector-row-title">
          Level {index + 1} (score {index})
        </span>
        <button
          type="button"
          className="btn ghost sm danger"
          data-testid={`decision-level-${index}-remove`}
          aria-label={`Remove level ${index + 1}`}
          disabled={!canRemove}
          onClick={() => {
            const updated = removeDecisionLevel(node, label);
            if (updated !== null) onRoutingChange({ mode: updated.mode });
          }}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      <Field id={id} label="Label" required error={error}>
        <input
          id={id}
          className="inspector-input"
          data-testid={id}
          type="text"
          value={committed.text}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, undefined, error)}
          onChange={(event) => committed.onChange(event.currentTarget.value)}
        />
      </Field>
      <Field id={`decision-level-${index}-description`} label="Description (optional)">
        <input
          id={`decision-level-${index}-description`}
          className="inspector-input"
          data-testid={`decision-level-${index}-description`}
          type="text"
          value={description ?? ""}
          onChange={(event) => {
            const updated = updateDecisionLevel(node, label, {
              description: event.currentTarget.value,
            });
            if (updated !== null) onRoutingChange({ mode: updated.mode });
          }}
        />
      </Field>
    </div>
  );
}

function BandAtLeastInput({
  node,
  bandId,
  atLeast,
  index,
  max,
  issue,
  onRoutingChange,
}: {
  node: DecisionNode;
  bandId: string;
  atLeast: number | null;
  index: number;
  max: number;
  issue: string | null;
  onRoutingChange: RoutingFormProps<DecisionNode>["onRoutingChange"];
}) {
  const buffered = useBufferedNumber(atLeast ?? undefined, {
    label: "Band atLeast",
    min: 0,
    max,
    integer: false,
    allowEmpty: false,
    onCommit: (next) => {
      if (next === undefined) return;
      const updated = updateDecisionBand(node, bandId, { atLeast: next });
      if (updated !== null) onRoutingChange({ mode: updated.mode });
    },
    bufferKey: `decision.${node.id}.band.${index}.atLeast`,
  });
  const error = buffered.localError ?? issue;
  const id = `decision-band-${index}-atleast`;
  return (
    <Field
      id={id}
      label={`Route here when score ≥ atLeast (0–${max})`}
      required
      help="Must stay strictly decreasing down the bands."
      error={error}
    >
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="decimal"
        value={buffered.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => buffered.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

export function DecisionForm({
  node,
  issues,
  edges,
  onPatch,
  onRoutingChange,
  projectId,
  runTest,
}: RoutingFormProps<DecisionNode> & {
  projectId?: string | undefined;
  runTest?: DecisionTestRunner | undefined;
}) {
  const providerIssue = fieldIssue(issues, "/provider");
  const modelIssue = fieldIssue(issues, "/model");
  const stateIssue = fieldIssue(issues, "/state");
  const instructionsIssue = fieldIssue(issues, "/instructions");
  const onErrorIssue = fieldIssue(issues, "/onError");
  const modeIssue = fieldIssue(issues, "/mode");

  const model = useBufferedText(
    node.model ?? "",
    (next) => {
      if (next === "") return null;
      return DECISION_MODEL_PATTERN.test(next)
        ? null
        : "Model must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/. Blank uses the preset model.";
    },
    (next) => onPatch({ model: next === "" ? undefined : next }),
    `decision.${node.id}.model`,
  );
  const modelError = model.localError ?? modelIssue;

  const instructions = useBufferedText(
    node.instructions,
    (next) => {
      if (next.length < 1 || next.length > 4000) return "Instructions must be 1–4000 characters.";
      return null;
    },
    (next) => onPatch({ instructions: next }),
    `decision.${node.id}.instructions`,
  );
  const instructionsError = instructions.localError ?? instructionsIssue;

  const minConfidence =
    node.mode.kind === "choice" || node.mode.kind === "score" ? (
      <MinConfidenceInput node={node} issues={issues} onPatch={onPatch} />
    ) : null;

  const { providers } = useDecisionProviders();
  const readiness = decisionReadiness(providers, node.provider);

  return (
    <>
      <InspectorSection sectionKey="decision:provider" title="Provider">
        <div className="inspector-stack">
          <Field
            id="decision-provider"
            label="Provider"
            required
            help="Fixed preset. Only the URL, auth and model string differ per provider."
            error={providerIssue}
          >
            <select
              id="decision-provider"
              className="inspector-input"
              data-testid="decision-provider"
              value={node.provider}
              aria-invalid={providerIssue ? true : undefined}
              aria-describedby={describedBy("decision-provider", undefined, providerIssue)}
              onChange={(event) =>
                onPatch({ provider: event.currentTarget.value as DecisionNode["provider"] })
              }
            >
              {DECISION_PROVIDERS.map((id) => (
                <option key={id} value={id}>
                  {DECISION_PROVIDER_LABELS[id]}
                </option>
              ))}
            </select>
          </Field>
          <ProviderReadiness node={node} />
          <Field
            id="decision-model"
            label="Model override (optional)"
            help="Blank uses the preset model. Cloudflare presets keep their URL path; only the body model changes."
            error={modelError}
          >
            <input
              id="decision-model"
              className="inspector-input mono"
              data-testid="decision-model"
              type="text"
              value={model.text}
              placeholder="Preset default"
              aria-invalid={modelError ? true : undefined}
              aria-describedby={describedBy("decision-model", undefined, modelError)}
              onChange={(event) => model.onChange(event.currentTarget.value)}
            />
          </Field>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="decision:question" title="Question">
        <div className="inspector-stack">
          <Field
            id="decision-state"
            label="State template"
            required
            help="Template over run params and ancestor outputs. Supports {{ start.param }} and ancestor output templates."
            error={stateIssue}
          >
            <textarea
              id="decision-state"
              className="inspector-input inspector-textarea inspector-code-input"
              data-testid="decision-state"
              rows={4}
              spellCheck={false}
              value={node.state}
              aria-invalid={stateIssue ? true : undefined}
              aria-describedby={describedBy("decision-state", undefined, stateIssue)}
              onChange={(event) => onPatch({ state: event.currentTarget.value })}
            />
          </Field>
          <Field
            id="decision-instructions"
            label="Instructions"
            required
            help="The single question asked of the decision model, 1–4000 characters."
            error={instructionsError}
          >
            <textarea
              id="decision-instructions"
              className="inspector-input inspector-textarea"
              data-testid="decision-instructions"
              rows={4}
              value={instructions.text}
              maxLength={4000}
              aria-invalid={instructionsError ? true : undefined}
              aria-describedby={describedBy("decision-instructions", undefined, instructionsError)}
              onChange={(event) => instructions.onChange(event.currentTarget.value)}
            />
          </Field>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="decision:mode" title="Mode">
        <div className="inspector-stack">
          <Field
            id="decision-mode"
            label="Answer mode"
            help="Switching mode replaces the mode config in one undoable step; undo restores it."
            error={modeIssue}
          >
            <div className="inspector-segmented" role="radiogroup" aria-label="Answer mode">
              {(["boolean", "choice", "score"] as const).map((kind) => (
                <label key={kind} className="inspector-check">
                  <input
                    type="radio"
                    name="decision-mode"
                    data-testid={`decision-mode-${kind}`}
                    checked={node.mode.kind === kind}
                    onChange={() => {
                      if (node.mode.kind !== kind)
                        onRoutingChange({ mode: defaultDecisionMode(kind) });
                    }}
                  />
                  <span style={{ textTransform: "capitalize" }}>{kind}</span>
                </label>
              ))}
            </div>
          </Field>
          {node.mode.kind === "boolean" ? (
            <div className="inspector-stack">
              <p className="inspector-help">
                Route true when P(yes) is at or above trueAt, false when at or below falseAt,
                otherwise uncertain. Equal thresholds leave no uncertain gap except refusals.
              </p>
              <ThresholdInput
                node={node}
                field="trueAt"
                label="trueAt"
                help="P(yes) at or above this routes true."
                issues={issues}
                onPatch={onPatch}
              />
              <ThresholdInput
                node={node}
                field="falseAt"
                label="falseAt"
                help="P(yes) at or below this routes false."
                issues={issues}
                onPatch={onPatch}
              />
            </div>
          ) : null}
          {node.mode.kind === "choice" ? (
            <ChoiceEditor
              node={node}
              issues={issues}
              edges={edges}
              onRoutingChange={onRoutingChange}
            />
          ) : null}
          {node.mode.kind === "score" ? (
            <ScoreEditor
              node={node}
              issues={issues}
              edges={edges}
              onRoutingChange={onRoutingChange}
            />
          ) : null}
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="decision:routing" title="Routing">
        <div className="inspector-stack">
          {minConfidence}
          <Field
            id="decision-onerror"
            label="On provider error"
            help="'Fail' stops the run on provider errors. 'Uncertain' routes them to the uncertain handle instead."
            error={onErrorIssue}
          >
            <div className="inspector-segmented" role="radiogroup" aria-label="On provider error">
              {(["fail", "uncertain"] as const).map((value) => (
                <label key={value} className="inspector-check">
                  <input
                    type="radio"
                    name="decision-onerror"
                    data-testid={`decision-onerror-${value}`}
                    checked={(node.onError ?? "fail") === value}
                    onChange={() => onPatch({ onError: value })}
                  />
                  <span style={{ textTransform: "capitalize" }}>{value}</span>
                </label>
              ))}
            </div>
          </Field>
          <p className="inspector-help" data-testid="decision-handles">
            Handles:{" "}
            {decisionHandles(node).map((handle) => (
              <span key={handle} className="mono" style={{ marginRight: 6 }}>
                {handle}
                {edgeCount(edges, `${node.id}.${handle}`) === 0 ? " (unwired)" : ""}
              </span>
            ))}
          </p>
        </div>
      </InspectorSection>
      <InspectorSection sectionKey="decision:tester" title="Decision tester">
        <DecisionTester node={node} projectId={projectId} readiness={readiness} runTest={runTest} />
      </InspectorSection>
    </>
  );
}

function MinConfidenceInput({
  node,
  issues,
  onPatch,
}: {
  node: DecisionNode;
  issues: Parameters<typeof fieldIssue>[0];
  onPatch: RoutingFormProps<DecisionNode>["onPatch"];
}) {
  const mode = node.mode;
  const buffered = useBufferedNumber(
    mode.kind === "choice" || mode.kind === "score" ? mode.minConfidence : undefined,
    {
      label: "minConfidence",
      min: 0,
      max: 1,
      integer: false,
      allowEmpty: true,
      onCommit: (next) => {
        if (mode.kind === "choice") {
          const { minConfidence: _omit, ...kept } = mode;
          onPatch({ mode: next === undefined ? kept : { ...kept, minConfidence: next } });
        } else if (mode.kind === "score") {
          const { minConfidence: _omit, ...kept } = mode;
          onPatch({ mode: next === undefined ? kept : { ...kept, minConfidence: next } });
        }
      },
      bufferKey: `decision.${node.id}.mode.minConfidence`,
    },
  );
  if (mode.kind !== "choice" && mode.kind !== "score") return null;
  const error = buffered.localError ?? fieldIssue(issues, "/mode/minConfidence");
  const id = "decision-min-confidence";
  return (
    <Field
      id={id}
      label="minConfidence (0–1, blank unset)"
      help="Below this confidence the run takes uncertain. A null confidence with minConfidence set also routes uncertain."
      error={error}
    >
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="decimal"
        placeholder="Unset"
        value={buffered.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => buffered.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}
