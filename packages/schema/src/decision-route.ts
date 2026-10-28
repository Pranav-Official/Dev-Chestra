import type { DecisionMode, DecisionNode } from "./types.js";
import { DECISION_UNCERTAIN_HANDLE } from "./types.js";

export interface DecisionOutputLike {
  kind: "boolean" | "choice" | "score";
  value: boolean | string | null;
  probability?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence: number | null;
  refusal?: { reason?: string };
}

export interface DecisionRoute {
  branch: string | null;
  reason: "matched" | "low_confidence" | "refused";
}

function maxProb(probabilities: Record<string, number> | undefined): number | null {
  if (probabilities === undefined) return null;
  let best: number | null = null;
  for (const v of Object.values(probabilities)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

function effectiveConfidence(output: DecisionOutputLike): number | null {
  if (typeof output.confidence === "number" && Number.isFinite(output.confidence)) {
    return output.confidence;
  }
  if (output.kind === "boolean" && typeof output.probability === "number") {
    const p = output.probability;
    if (Number.isFinite(p)) return Math.max(p, 1 - p);
  }
  return maxProb(output.probabilities);
}

/** Pure, browser-safe routing for decision nodes (contract section 4). */
export function routeDecision(mode: DecisionMode, output: DecisionOutputLike): DecisionRoute {
  if (output.refusal !== undefined || output.value === null) {
    return { branch: DECISION_UNCERTAIN_HANDLE, reason: "refused" };
  }
  if (mode.kind === "boolean") {
    if (typeof output.probability !== "number" || !Number.isFinite(output.probability)) {
      return { branch: DECISION_UNCERTAIN_HANDLE, reason: "refused" };
    }
    const p = output.probability;
    const trueAt = mode.trueAt ?? 0.5;
    const falseAt = mode.falseAt ?? 0.5;
    if (p >= trueAt) return { branch: "true", reason: "matched" };
    if (p <= falseAt) return { branch: "false", reason: "matched" };
    return { branch: DECISION_UNCERTAIN_HANDLE, reason: "low_confidence" };
  }
  if (mode.kind === "choice") {
    if (typeof output.value !== "string") {
      return { branch: DECISION_UNCERTAIN_HANDLE, reason: "refused" };
    }
    if (mode.minConfidence !== undefined) {
      const c = effectiveConfidence(output);
      if (c === null || c < mode.minConfidence) {
        return { branch: DECISION_UNCERTAIN_HANDLE, reason: "low_confidence" };
      }
    }
    const branch = mode.branches.find((b) => b.values.includes(output.value as string));
    if (branch === undefined) {
      return { branch: DECISION_UNCERTAIN_HANDLE, reason: "refused" };
    }
    return { branch: branch.id, reason: "matched" };
  }
  // score
  if (typeof output.score !== "number" || !Number.isFinite(output.score)) {
    return { branch: DECISION_UNCERTAIN_HANDLE, reason: "refused" };
  }
  if (mode.minConfidence !== undefined) {
    const c = effectiveConfidence(output);
    if (c === null || c < mode.minConfidence) {
      return { branch: DECISION_UNCERTAIN_HANDLE, reason: "low_confidence" };
    }
  }
  const ordered = [...mode.bands].sort((a, b) => {
    if (a.atLeast === null) return 1;
    if (b.atLeast === null) return -1;
    return b.atLeast - a.atLeast;
  });
  for (const band of ordered) {
    if (band.atLeast === null) return { branch: band.id, reason: "matched" };
    if ((output.score as number) >= band.atLeast) return { branch: band.id, reason: "matched" };
  }
  const floor = mode.bands.find((b) => b.atLeast === null);
  return {
    branch: floor !== undefined ? floor.id : DECISION_UNCERTAIN_HANDLE,
    reason: "matched",
  };
}

/** Output handle ids for a decision node (each branch/band plus `uncertain`). */
export function decisionHandles(node: DecisionNode): string[] {
  const mode = node.mode;
  if (mode.kind === "boolean") return ["true", "false", DECISION_UNCERTAIN_HANDLE];
  if (mode.kind === "choice") return [...mode.branches.map((b) => b.id), DECISION_UNCERTAIN_HANDLE];
  return [...mode.bands.map((b) => b.id), DECISION_UNCERTAIN_HANDLE];
}
