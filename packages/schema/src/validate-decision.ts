import type { RelayError } from "@relay/core";
import { HANDLE_ID_PATTERN } from "./ids.js";
import { compileTemplate } from "./template.js";
import {
  DECISION_MODEL_PATTERN,
  DECISION_UNCERTAIN_HANDLE,
  type DecisionNode,
  type Issue,
  isDecisionProviderId,
} from "./types.js";
import { issue } from "./validate-support.js";

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Names that collide with Object.prototype members. As option values or level
 * labels they would be silently dropped from (or misread in) plain-object
 * maps; as branch/band ids they invite the same confusion downstream (F9).
 */
const RESERVED_DECISION_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function validateDecision(
  node: DecisionNode,
  pointer: string,
  allowed: Set<string>,
  addError: (i: Issue) => void,
  addRelay: (e: RelayError, p: string, n?: string) => void,
): void {
  if (!isDecisionProviderId((node as { provider?: unknown }).provider)) {
    addError(
      issue(
        "error",
        "E_DECISION_PROVIDER",
        "Decision provider must be one of typesafe-jev, cloudflare-clef, cloudflare-clef-flash.",
        `${pointer}/provider`,
        node.id,
      ),
    );
  }
  const model = (node as { model?: unknown }).model;
  if (model !== undefined) {
    if (typeof model !== "string" || !DECISION_MODEL_PATTERN.test(model)) {
      addError(
        issue(
          "error",
          "E_DECISION_MODEL",
          `Decision model must match ${DECISION_MODEL_PATTERN.source}.`,
          `${pointer}/model`,
          node.id,
        ),
      );
    }
  }
  if (typeof node.state !== "string" || node.state === "") {
    addError(
      issue(
        "error",
        "E_DECISION_STATE",
        "Decision state must be a non-empty string.",
        `${pointer}/state`,
        node.id,
      ),
    );
  } else {
    const c = compileTemplate(node.state, { shell: false });
    if (!c.ok) addRelay(c.error, `${pointer}/state`, node.id);
    else
      for (const p of c.value.parts)
        if (p.kind === "expression")
          for (const r of p.compiled.roots)
            if (!allowed.has(r))
              addError(
                issue(
                  "error",
                  "E_EXPR_SCOPE",
                  `Expression root '${r}' is not in scope. Allowed: ${[...allowed].sort().join(", ") || "(none)"}. Expression: state: {{ ${p.source} }}`,
                  `${pointer}/state`,
                  node.id,
                ),
              );
  }
  if (
    typeof node.instructions !== "string" ||
    node.instructions.length < 1 ||
    node.instructions.length > 4000
  ) {
    addError(
      issue(
        "error",
        "E_DECISION_INSTRUCTIONS",
        "Decision instructions must be 1..4000 characters.",
        `${pointer}/instructions`,
        node.id,
      ),
    );
  }
  const onError = (node as { onError?: unknown }).onError ?? "fail";
  if (onError !== "fail" && onError !== "uncertain") {
    addError(
      issue(
        "error",
        "E_DECISION_ON_ERROR",
        "Decision onError must be 'fail' or 'uncertain'.",
        `${pointer}/onError`,
        node.id,
      ),
    );
  }
  const mode = (node as { mode?: unknown }).mode as DecisionNode["mode"] | undefined;
  if (mode === undefined || typeof mode !== "object" || mode === null) {
    addError(
      issue("error", "E_DECISION_MODE", "Decision mode is required.", `${pointer}/mode`, node.id),
    );
    return;
  }
  if (mode.kind === "boolean") {
    const trueAt = mode.trueAt ?? 0.5;
    const falseAt = mode.falseAt ?? 0.5;
    for (const [label, v] of [
      ["trueAt", trueAt],
      ["falseAt", falseAt],
    ] as const) {
      if (!isConfidence(v)) {
        addError(
          issue(
            "error",
            "E_DECISION_THRESHOLD",
            `Decision boolean ${label} must be a number in [0,1].`,
            `${pointer}/mode/${label}`,
            node.id,
          ),
        );
      }
    }
    if (isConfidence(trueAt) && isConfidence(falseAt) && falseAt > trueAt) {
      addError(
        issue(
          "error",
          "E_DECISION_THRESHOLD",
          "Decision boolean falseAt must be <= trueAt.",
          `${pointer}/mode/falseAt`,
          node.id,
        ),
      );
    }
    return;
  }
  if (mode.kind === "choice") {
    const options = mode.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > 255) {
      addError(
        issue(
          "error",
          "E_DECISION_OPTIONS",
          "Decision choice options must have 1..255 entries.",
          `${pointer}/mode/options`,
          node.id,
        ),
      );
    } else {
      const seen = new Set<string>();
      options.forEach((opt, i) => {
        const at = `${pointer}/mode/options/${i}`;
        if (typeof opt?.value !== "string" || opt.value.length < 1 || opt.value.length > 100) {
          addError(
            issue(
              "error",
              "E_DECISION_OPTIONS",
              "Decision choice option values must be 1..100 characters.",
              `${at}/value`,
              node.id,
            ),
          );
        } else if (RESERVED_DECISION_NAMES.has(opt.value)) {
          addError(
            issue(
              "error",
              "E_DECISION_OPTIONS",
              `Decision choice option '${opt.value}' is reserved and cannot be used.`,
              `${at}/value`,
              node.id,
            ),
          );
        } else if (seen.has(opt.value)) {
          addError(
            issue(
              "error",
              "E_DECISION_OPTIONS",
              `Decision choice option '${opt.value}' is duplicated.`,
              `${at}/value`,
              node.id,
            ),
          );
        } else seen.add(opt.value);
        if (opt?.description !== undefined && typeof opt.description !== "string") {
          addError(
            issue(
              "error",
              "E_DECISION_OPTIONS",
              "Decision choice option description must be a string.",
              `${at}/description`,
              node.id,
            ),
          );
        }
      });
    }
    const branches = mode.branches;
    if (!Array.isArray(branches) || branches.length === 0) {
      addError(
        issue(
          "error",
          "E_DECISION_BRANCHES",
          "Decision choice must declare at least one branch.",
          `${pointer}/mode/branches`,
          node.id,
        ),
      );
    } else {
      const seenId = new Set<string>();
      const covered = new Map<string, string>();
      branches.forEach((b, i) => {
        const at = `${pointer}/mode/branches/${i}`;
        if (typeof b?.id !== "string" || !HANDLE_ID_PATTERN.test(b.id)) {
          addError(
            issue(
              "error",
              "E_DECISION_BRANCH_ID",
              `Decision branch id '${String(b?.id)}' must match ${HANDLE_ID_PATTERN.source}.`,
              `${at}/id`,
              node.id,
            ),
          );
        } else {
          if (b.id === DECISION_UNCERTAIN_HANDLE) {
            addError(
              issue(
                "error",
                "E_DECISION_BRANCH_ID",
                `'${DECISION_UNCERTAIN_HANDLE}' is reserved and cannot be a branch id.`,
                `${at}/id`,
                node.id,
              ),
            );
          }
          if (RESERVED_DECISION_NAMES.has(b.id)) {
            addError(
              issue(
                "error",
                "E_DECISION_BRANCH_ID",
                `Decision branch id '${b.id}' is reserved and cannot be used.`,
                `${at}/id`,
                node.id,
              ),
            );
          }
          if (seenId.has(b.id)) {
            addError(
              issue(
                "error",
                "E_DECISION_BRANCH_ID",
                `Decision has duplicate branch id '${b.id}'.`,
                `${at}/id`,
                node.id,
              ),
            );
          }
          seenId.add(b.id);
        }
        if (!Array.isArray(b?.values)) {
          addError(
            issue(
              "error",
              "E_DECISION_BRANCH_VALUES",
              "Decision branch values must be an array.",
              `${at}/values`,
              node.id,
            ),
          );
        } else {
          for (const v of b.values) {
            if (typeof v !== "string") {
              addError(
                issue(
                  "error",
                  "E_DECISION_BRANCH_VALUES",
                  "Decision branch values must be strings.",
                  `${at}/values`,
                  node.id,
                ),
              );
              continue;
            }
            if (covered.has(v)) {
              addError(
                issue(
                  "error",
                  "E_DECISION_BRANCH_VALUES",
                  `Decision option '${v}' is in more than one branch.`,
                  `${at}/values`,
                  node.id,
                ),
              );
            } else covered.set(v, b.id);
          }
        }
      });
      const optionValues = new Set(
        (Array.isArray(options) ? options : []).map(
          (o) => (o as { value?: unknown }).value as string,
        ),
      );
      for (const v of covered.keys()) {
        if (!optionValues.has(v)) {
          addError(
            issue(
              "error",
              "E_DECISION_BRANCH_VALUES",
              `Decision branch value '${v}' is not a declared option.`,
              `${pointer}/mode/branches`,
              node.id,
            ),
          );
        }
      }
      for (const v of optionValues) {
        if (typeof v === "string" && !covered.has(v)) {
          addError(
            issue(
              "error",
              "E_DECISION_BRANCH_VALUES",
              `Decision option '${v}' is not in any branch.`,
              `${pointer}/mode/branches`,
              node.id,
            ),
          );
        }
      }
    }
    if (mode.minConfidence !== undefined && !isConfidence(mode.minConfidence)) {
      addError(
        issue(
          "error",
          "E_DECISION_CONFIDENCE",
          "Decision minConfidence must be a number in [0,1].",
          `${pointer}/mode/minConfidence`,
          node.id,
        ),
      );
    }
    return;
  }
  if (mode.kind === "score") {
    const levels = mode.levels;
    if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
      addError(
        issue(
          "error",
          "E_DECISION_LEVELS",
          "Decision score levels must have 2..10 entries.",
          `${pointer}/mode/levels`,
          node.id,
        ),
      );
    } else {
      const seen = new Set<string>();
      levels.forEach((l, i) => {
        const at = `${pointer}/mode/levels/${i}`;
        if (typeof l?.label !== "string" || l.label.length === 0) {
          addError(
            issue(
              "error",
              "E_DECISION_LEVELS",
              "Decision score level labels must be non-empty strings.",
              `${at}/label`,
              node.id,
            ),
          );
        } else if (RESERVED_DECISION_NAMES.has(l.label)) {
          addError(
            issue(
              "error",
              "E_DECISION_LEVELS",
              `Decision score level '${l.label}' is reserved and cannot be used.`,
              `${at}/label`,
              node.id,
            ),
          );
        } else if (seen.has(l.label)) {
          addError(
            issue(
              "error",
              "E_DECISION_LEVELS",
              `Decision score level '${l.label}' is duplicated.`,
              `${at}/label`,
              node.id,
            ),
          );
        } else seen.add(l.label);
        if (l?.description !== undefined && typeof l.description !== "string") {
          addError(
            issue(
              "error",
              "E_DECISION_LEVELS",
              "Decision score level description must be a string.",
              `${at}/description`,
              node.id,
            ),
          );
        }
      });
    }
    const bands = mode.bands;
    if (!Array.isArray(bands) || bands.length === 0) {
      addError(
        issue(
          "error",
          "E_DECISION_BANDS",
          "Decision score must declare at least one band.",
          `${pointer}/mode/bands`,
          node.id,
        ),
      );
    } else {
      const seenId = new Set<string>();
      let prev: number | null = null;
      let first = true;
      bands.forEach((b, i) => {
        const at = `${pointer}/mode/bands/${i}`;
        if (typeof b?.id !== "string" || !HANDLE_ID_PATTERN.test(b.id)) {
          addError(
            issue(
              "error",
              "E_DECISION_BRANCH_ID",
              `Decision band id '${String(b?.id)}' must match ${HANDLE_ID_PATTERN.source}.`,
              `${at}/id`,
              node.id,
            ),
          );
        } else {
          if (b.id === DECISION_UNCERTAIN_HANDLE) {
            addError(
              issue(
                "error",
                "E_DECISION_BRANCH_ID",
                `'${DECISION_UNCERTAIN_HANDLE}' is reserved and cannot be a band id.`,
                `${at}/id`,
                node.id,
              ),
            );
          }
          if (RESERVED_DECISION_NAMES.has(b.id)) {
            addError(
              issue(
                "error",
                "E_DECISION_BRANCH_ID",
                `Decision band id '${b.id}' is reserved and cannot be used.`,
                `${at}/id`,
                node.id,
              ),
            );
          }
          if (seenId.has(b.id)) {
            addError(
              issue(
                "error",
                "E_DECISION_BRANCH_ID",
                `Decision has duplicate band id '${b.id}'.`,
                `${at}/id`,
                node.id,
              ),
            );
          }
          seenId.add(b.id);
        }
        const atLeast = (b as { atLeast?: unknown }).atLeast;
        const isLast = i === bands.length - 1;
        if (atLeast === null) {
          if (!isLast) {
            addError(
              issue(
                "error",
                "E_DECISION_BANDS",
                "Decision null atLeast (floor) must be the last band.",
                `${at}/atLeast`,
                node.id,
              ),
            );
          }
        } else if (typeof atLeast !== "number" || !Number.isFinite(atLeast)) {
          addError(
            issue(
              "error",
              "E_DECISION_BANDS",
              "Decision band atLeast must be a number or null.",
              `${at}/atLeast`,
              node.id,
            ),
          );
        } else {
          const nLevels = Array.isArray(levels) ? levels.length : 0;
          if (atLeast < 0 || atLeast > Math.max(0, nLevels - 1)) {
            addError(
              issue(
                "error",
                "E_DECISION_BANDS",
                `Decision band atLeast must be within [0, levels-1].`,
                `${at}/atLeast`,
                node.id,
              ),
            );
          }
          if (!first && prev !== null && !(atLeast < prev)) {
            addError(
              issue(
                "error",
                "E_DECISION_BANDS",
                "Decision bands must have strictly decreasing atLeast.",
                `${at}/atLeast`,
                node.id,
              ),
            );
          }
          prev = atLeast;
        }
        first = false;
      });
      const last = bands[bands.length - 1];
      if (last !== undefined && (last as { atLeast?: unknown }).atLeast !== null) {
        addError(
          issue(
            "error",
            "E_DECISION_BANDS",
            "Decision last band must be the floor (atLeast null).",
            `${pointer}/mode/bands`,
            node.id,
          ),
        );
      }
    }
    if (mode.minConfidence !== undefined && !isConfidence(mode.minConfidence)) {
      addError(
        issue(
          "error",
          "E_DECISION_CONFIDENCE",
          "Decision minConfidence must be a number in [0,1].",
          `${pointer}/mode/minConfidence`,
          node.id,
        ),
      );
    }
    return;
  }
  addError(
    issue(
      "error",
      "E_DECISION_MODE",
      "Decision mode kind must be 'boolean', 'choice' or 'score'.",
      `${pointer}/mode/kind`,
      node.id,
    ),
  );
}
