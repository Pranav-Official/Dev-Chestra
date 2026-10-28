import { DevChestraError, type ErrorCode, err, ok, type Result } from "@devchestra/core";
import { compileExpression, type EvaluateOptions, evaluate } from "./expression.js";
import { HANDLE_ID_PATTERN } from "./ids.js";
import type { GateBranch } from "./types.js";

/** Hard cap for stateless gate previews and engine evaluation. */
export const MAX_GATE_BRANCHES = 32;
export const DEFAULT_GATE_TIMEOUT_MS = 2_000;
export const MAX_GATE_TIMEOUT_MS = 2_000;

export interface GateBranchEvaluation {
  readonly branch: string;
  readonly matched: boolean;
  readonly error?: string;
}

export interface GateEvaluationError {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface GateDecision {
  /** The chosen branch, or null when evaluation failed. */
  readonly branch: string | null;
  readonly evaluated: GateBranchEvaluation[];
  readonly error?: GateEvaluationError;
}

/** Naming alias used by the API/event contract. */
export type GateEvaluation = GateDecision;

export interface GateDefinition {
  readonly branches: readonly GateBranch[];
}

export interface EvaluateGateOptions extends EvaluateOptions {
  /** Optional cap at or below MAX_GATE_BRANCHES; defaults to the hard cap. */
  readonly maxBranches?: number;
  /** Hard total budget across the branch loop, default 2000 ms, max 2000 ms. */
  readonly overallTimeoutMs?: number;
}

function invalid(message: string, details?: unknown): DevChestraError {
  return new DevChestraError(
    "E_WORKFLOW_INVALID",
    message,
    details === undefined ? {} : { details },
  );
}

function validateBranches(gate: GateDefinition, max: number): DevChestraError | undefined {
  const branches = gate.branches;
  if (!Array.isArray(branches) || branches.length === 0) {
    return invalid("Gate must declare at least one branch");
  }
  if (branches.length > max) {
    return invalid(`Gate declares ${branches.length} branches; the maximum is ${max}`);
  }
  const seen = new Set<string>();
  let otherwise = 0;
  for (let index = 0; index < branches.length; index += 1) {
    const branch = branches[index];
    const at = `branches[${index}]`;
    if (
      branch === undefined ||
      typeof branch.id !== "string" ||
      !HANDLE_ID_PATTERN.test(branch.id)
    ) {
      return invalid(`Gate branch ${index} has an invalid id`, { pointer: `${at}/id` });
    }
    if (seen.has(branch.id)) {
      return invalid(`Gate has duplicate branch id '${branch.id}'`, { pointer: `${at}/id` });
    }
    seen.add(branch.id);
    if (branch.otherwise === true) {
      otherwise += 1;
      if (index !== branches.length - 1) {
        return invalid(`Gate otherwise branch '${branch.id}' must be last`, { pointer: at });
      }
      if (branch.when !== undefined) {
        return invalid(`Gate otherwise branch '${branch.id}' cannot also declare when`, {
          pointer: at,
        });
      }
    } else {
      if (typeof branch.when !== "string" || branch.when.trim() === "") {
        return invalid(`Gate branch '${branch.id}' must declare a when expression`, {
          pointer: at,
        });
      }
      if (branch.otherwise !== undefined) {
        return invalid(`Gate branch '${branch.id}' otherwise must be true when used`, {
          pointer: `${at}/otherwise`,
        });
      }
    }
  }
  if (otherwise !== 1) {
    return invalid(`Gate must have exactly one otherwise branch (found ${otherwise})`);
  }
  return undefined;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Evaluate a gate's ordered branches. The first true branch wins; `otherwise`
 * matches without evaluating an expression. A non-boolean result or an
 * expression error stops evaluation and fails the gate: branch is null and the
 * error is returned in the decision (never a silent fallthrough). Malformed gate
 * configuration is a Result error.
 */
export async function evaluateGate(
  gate: GateDefinition,
  scope: Readonly<Record<string, unknown>>,
  options: EvaluateGateOptions = {},
): Promise<Result<GateDecision, DevChestraError>> {
  const max = options.maxBranches ?? MAX_GATE_BRANCHES;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_GATE_BRANCHES) {
    return err(invalid(`maxBranches must be between 1 and ${MAX_GATE_BRANCHES}`));
  }
  const problem = validateBranches(gate, max);
  if (problem !== undefined) return err(problem);

  const overall = options.overallTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  if (!Number.isSafeInteger(overall) || overall < 1 || overall > MAX_GATE_TIMEOUT_MS) {
    return err(invalid(`overallTimeoutMs must be between 1 and ${MAX_GATE_TIMEOUT_MS}`));
  }
  const deadline = Date.now() + overall;
  const perBranch = options.timeoutMs ?? 250;

  const evaluated: GateBranchEvaluation[] = [];
  for (const branch of gate.branches) {
    const remaining = deadline - Date.now();
    if (remaining < 1) {
      const message = `Gate exceeded its ${overall}ms overall evaluation budget`;
      evaluated.push({ branch: branch.id, matched: false, error: message });
      return ok({ branch: null, evaluated, error: { code: "E_EXPR", message } });
    }
    if (branch.otherwise === true) {
      evaluated.push({ branch: branch.id, matched: true });
      return ok({ branch: branch.id, evaluated });
    }

    const compiled = compileExpression(branch.when as string);
    if (!compiled.ok) {
      evaluated.push({ branch: branch.id, matched: false, error: compiled.error.message });
      return ok({
        branch: null,
        evaluated,
        error: { code: "E_EXPR", message: compiled.error.message },
      });
    }
    const remainingAfterCompile = deadline - Date.now();
    if (remainingAfterCompile < 1) {
      const message = `Gate exceeded its ${overall}ms overall evaluation budget`;
      evaluated.push({ branch: branch.id, matched: false, error: message });
      return ok({ branch: null, evaluated, error: { code: "E_EXPR", message } });
    }
    const timeoutMs = Math.min(perBranch, remainingAfterCompile);
    const result = await evaluate(compiled.value, scope, {
      timeoutMs,
      ...(options.executor === undefined ? {} : { executor: options.executor }),
    });
    const remainingAfterEvaluate = deadline - Date.now();
    if (remainingAfterEvaluate < 1) {
      const message = `Gate exceeded its ${overall}ms overall evaluation budget`;
      evaluated.push({ branch: branch.id, matched: false, error: message });
      return ok({ branch: null, evaluated, error: { code: "E_EXPR", message } });
    }
    if (!result.ok) {
      evaluated.push({ branch: branch.id, matched: false, error: result.error.message });
      return ok({
        branch: null,
        evaluated,
        error: { code: "E_EXPR", message: result.error.message },
      });
    }
    if (typeof result.value !== "boolean") {
      const message = `Gate branch '${branch.id}' returned ${typeName(result.value)}; when must evaluate to a boolean`;
      evaluated.push({ branch: branch.id, matched: false, error: message });
      return ok({ branch: null, evaluated, error: { code: "E_EXPR", message } });
    }
    if (result.value) {
      evaluated.push({ branch: branch.id, matched: true });
      return ok({ branch: branch.id, evaluated });
    }
    evaluated.push({ branch: branch.id, matched: false });
  }

  const message = "Gate produced no matching branch; every gate must end with otherwise";
  return ok({ branch: null, evaluated, error: { code: "E_WORKFLOW_INVALID", message } });
}
