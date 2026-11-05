import { DevChestraError, err, isRecord, ok, type Result } from "@devchestra/core";
import { type AgentCli, isModelTierId, MODEL_TIERS, type ModelTierId, PROD_CLIS } from "./types.js";

/**
 * Project settings live in two files under `<project>/.devchestra/`:
 *
 * - `settings.json` is committed and shared by everyone on the project.
 * - `settings.local.json` is ignored by git and holds this machine's choices.
 *
 * Both use the same shape. A value in the local file wins over the same value in
 * the committed one. Settings never hold secrets.
 */
export const SETTINGS_VERSION = 1;

export const SETTINGS_SCOPES = ["project", "local"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

export const SETTINGS_FILE_NAMES: Record<SettingsScope, string> = {
  project: "settings.json",
  local: "settings.local.json",
};

/** Hard cap for either settings file; the real files are a few hundred bytes. */
export const MAX_SETTINGS_FILE_BYTES = 64 * 1024;

export const MAX_MODEL_ID_LENGTH = 200;

/** A provider CLI and optionally one of its models. No model means the CLI's own default. */
export interface ModelRef {
  cli: AgentCli;
  model?: string;
}

export type ModelTierMap = Partial<Record<ModelTierId, ModelRef>>;

export interface SettingsFile {
  version: typeof SETTINGS_VERSION;
  models?: ModelTierMap;
}

/** What a settings file parse returns: the file plus notes about anything it ignored. */
export interface ParsedSettings {
  file: SettingsFile;
  warnings: string[];
}

export type EffectiveModelTier = { ref: ModelRef; source: SettingsScope };
export type EffectiveModelTiers = Partial<Record<ModelTierId, EffectiveModelTier>>;

const prodClis: readonly string[] = PROD_CLIS;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalid(message: string, pointer: string): DevChestraError {
  return new DevChestraError("E_VALIDATION", message, { details: { pointer } });
}

/** Validates one `{ cli, model? }` entry. Returns the trimmed, canonical value. */
export function parseModelRef(value: unknown, pointer: string): Result<ModelRef, DevChestraError> {
  if (!isRecord(value)) return err(invalid("A model tier must be an object.", pointer));
  for (const key of Object.keys(value)) {
    if (key !== "cli" && key !== "model") {
      return err(invalid(`Unknown key '${key}' in a model tier.`, `${pointer}/${key}`));
    }
  }
  const cli = value.cli;
  if (typeof cli !== "string" || !prodClis.includes(cli)) {
    return err(invalid(`cli must be one of ${PROD_CLIS.join(", ")}.`, `${pointer}/cli`));
  }
  const ref: ModelRef = { cli: cli as AgentCli };
  if (value.model !== undefined) {
    if (typeof value.model !== "string") {
      return err(invalid("model must be a string.", `${pointer}/model`));
    }
    const model = value.model.trim();
    if (model === "") return ok(ref);
    if (model.length > MAX_MODEL_ID_LENGTH || hasControlChars(model)) {
      return err(
        invalid(
          `model must be at most ${MAX_MODEL_ID_LENGTH} characters with no control characters.`,
          `${pointer}/model`,
        ),
      );
    }
    ref.model = model;
  }
  return ok(ref);
}

/** Validates the `models` object of a settings file. */
export function parseModelTierMap(
  value: unknown,
  pointer = "/models",
): Result<ModelTierMap, DevChestraError> {
  if (!isRecord(value)) return err(invalid("models must be an object.", pointer));
  const out: ModelTierMap = {};
  for (const key of Object.keys(value)) {
    if (!isModelTierId(key)) {
      return err(
        invalid(`Unknown model tier '${key}'. Use ${MODEL_TIERS.join(", ")}.`, `${pointer}/${key}`),
      );
    }
  }
  for (const tier of MODEL_TIERS) {
    const entry = value[tier];
    if (entry === undefined) continue;
    const parsed = parseModelRef(entry, `${pointer}/${tier}`);
    if (!parsed.ok) return parsed;
    out[tier] = parsed.value;
  }
  return ok(out);
}

/** Validates an already-parsed JSON value as a settings file. Unknown top-level keys are ignored with a warning. */
export function parseSettingsValue(value: unknown): Result<ParsedSettings, DevChestraError> {
  if (!isRecord(value)) return err(invalid("Settings must be a JSON object.", ""));
  if (value.version !== SETTINGS_VERSION) {
    return err(invalid(`Settings version must be ${SETTINGS_VERSION}.`, "/version"));
  }
  const file: SettingsFile = { version: SETTINGS_VERSION };
  const warnings: string[] = [];
  for (const key of Object.keys(value)) {
    if (key === "version" || key === "models") continue;
    warnings.push(`Ignoring unknown settings key '${key}'.`);
  }
  if (value.models !== undefined) {
    const models = parseModelTierMap(value.models);
    if (!models.ok) return models;
    if (Object.keys(models.value).length > 0) file.models = models.value;
  }
  return ok({ file, warnings });
}

/** Parses the text of a settings file. */
export function parseSettings(text: string): Result<ParsedSettings, DevChestraError> {
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_FILE_BYTES) {
    return err(
      new DevChestraError(
        "E_VALIDATION",
        `Settings file exceeds the ${MAX_SETTINGS_FILE_BYTES / 1024} KiB limit.`,
      ),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return err(
      new DevChestraError(
        "E_VALIDATION",
        `Settings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  return parseSettingsValue(json);
}

/** Canonical text for a settings file: tiers in high, medium, low order, two-space indent, trailing newline. */
export function serializeSettings(file: SettingsFile): string {
  const out: Record<string, unknown> = { version: SETTINGS_VERSION };
  if (file.models !== undefined) {
    const models: Record<string, ModelRef> = {};
    for (const tier of MODEL_TIERS) {
      const ref = file.models[tier];
      if (ref === undefined) continue;
      models[tier] =
        ref.model === undefined ? { cli: ref.cli } : { cli: ref.cli, model: ref.model };
    }
    if (Object.keys(models).length > 0) out.models = models;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The local layer wins per tier; a tier set in neither layer is absent from the result. */
export function mergeModelTiers(
  project: SettingsFile | null | undefined,
  local: SettingsFile | null | undefined,
): EffectiveModelTiers {
  const out: EffectiveModelTiers = {};
  for (const tier of MODEL_TIERS) {
    const localRef = local?.models?.[tier];
    if (localRef !== undefined) {
      out[tier] = { ref: localRef, source: "local" };
      continue;
    }
    const projectRef = project?.models?.[tier];
    if (projectRef !== undefined) out[tier] = { ref: projectRef, source: "project" };
  }
  return out;
}

export interface ModelTierUse {
  nodeId: string;
  nodeName: string;
  tier: ModelTierId;
}

export interface UnresolvedModelTier extends ModelTierUse {
  /** Set when the tier is mapped but its CLI cannot be used (for example it is turned off). */
  reason: "unset";
}

function tierOf(node: Record<string, unknown>): ModelTierId | null {
  return node.type === "agent" && isModelTierId(node.tier) ? node.tier : null;
}

/** Visits every agent node a run can reach in one snapshot: top level, loop and for-each bodies, and the polling probe. */
function visitAgents(
  graph: unknown,
  visit: (node: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) return graph;
  const nodes = graph.nodes.map((node: unknown) => {
    if (!isRecord(node)) return node;
    let next: Record<string, unknown> = node;
    if (node.type === "agent") next = visit(node);
    if ((node.type === "loop" || node.type === "foreach") && node.body !== undefined) {
      const body = visitAgents(node.body, visit);
      if (body !== node.body) next = { ...next, body };
    }
    if (node.type === "start" && isRecord(node.polling) && isRecord(node.polling.probe)) {
      const probe = node.polling.probe;
      if (probe.type === "agent") {
        const resolved = visit(probe);
        if (resolved !== probe) next = { ...next, polling: { ...node.polling, probe: resolved } };
      }
    }
    return next;
  });
  return { ...graph, nodes };
}

function snapshotGraph(snapshot: unknown): unknown {
  return isRecord(snapshot) ? snapshot.graph : undefined;
}

/** Every agent node in the snapshot that names a tier. */
export function collectModelTierUses(snapshot: unknown): ModelTierUse[] {
  const uses: ModelTierUse[] = [];
  visitAgents(snapshotGraph(snapshot), (node) => {
    const tier = tierOf(node);
    if (tier !== null) {
      uses.push({
        nodeId: typeof node.id === "string" ? node.id : "",
        nodeName: typeof node.name === "string" ? node.name : "",
        tier,
      });
    }
    return node;
  });
  return uses;
}

export interface AppliedModelTiers<T> {
  snapshot: T;
  unresolved: UnresolvedModelTier[];
}

/**
 * Replaces every tiered agent node with a concrete `cli` and `model` taken from the machine's
 * tier mapping, and removes its `tier`. A tier with
 * no mapping is reported in `unresolved` and its node is left unchanged; callers must refuse
 * to run a snapshot with unresolved tiers. A snapshot without tiered nodes comes back as is.
 */
export function applyModelTiers<T>(snapshot: T, tiers: EffectiveModelTiers): AppliedModelTiers<T> {
  const unresolved: UnresolvedModelTier[] = [];
  if (collectModelTierUses(snapshot).length === 0) return { snapshot, unresolved };
  const graph = visitAgents(snapshotGraph(snapshot), (node) => {
    const tier = tierOf(node);
    if (tier === null) return node;
    const mapped = tiers[tier];
    if (mapped === undefined) {
      unresolved.push({
        nodeId: typeof node.id === "string" ? node.id : "",
        nodeName: typeof node.name === "string" ? node.name : "",
        tier,
        reason: "unset",
      });
      return node;
    }
    // The tier is dropped: a node that names both a tier and a provider is invalid, and the
    // engine validates loop bodies again at run time. The authored snapshot keeps the tier.
    const { model: _model, tier: _tier, ...rest } = node;
    return {
      ...rest,
      cli: mapped.ref.cli,
      ...(mapped.ref.model === undefined ? {} : { model: mapped.ref.model }),
    };
  });
  return { snapshot: { ...(snapshot as object), graph } as T, unresolved };
}

/** One message naming every tier a run needs that this machine has not mapped. */
export function unmappedTierMessage(unresolved: readonly UnresolvedModelTier[]): string {
  const tiers = [...new Set(unresolved.map((item) => item.tier))];
  const nodes = unresolved.map((item) => item.nodeName || item.nodeId).filter((n) => n !== "");
  const listed = tiers.map((tier) => `'${tier}'`).join(", ");
  const where = nodes.length === 0 ? "" : ` (used by ${[...new Set(nodes)].join(", ")})`;
  return `Model tier ${listed} is not set on this machine${where}. Set it in Project settings, or with \`devchestra settings set ${tiers[0] ?? "high"} <cli> [model]\`.`;
}
