import type { ExecStatus } from "@relay/core";
import type { LinearChain, LinearNode } from "./sequence.js";

export interface ChainStepState {
  readonly status: ExecStatus;
  readonly hasOutput: boolean;
}

export type NextStep =
  | {
      readonly kind: "dispatch";
      readonly node: LinearNode;
      readonly index: number;
      readonly resume: boolean;
    }
  | { readonly kind: "wait"; readonly node: LinearNode; readonly status: ExecStatus }
  | { readonly kind: "failed"; readonly node: LinearNode; readonly status: ExecStatus }
  | { readonly kind: "complete" };

const WAITING = new Set<ExecStatus>(["running", "validating", "waiting_approval", "waiting_quota"]);
const FAILED = new Set<ExecStatus>(["failed", "rejected", "cancelled"]);

export function nextChainStep(
  chain: LinearChain,
  states: Readonly<Record<string, ChainStepState>>,
): NextStep {
  for (const [index, node] of chain.nodes.entries()) {
    const state = states[node.id];
    if (state === undefined || state.status === "pending" || state.status === "ready") {
      return { kind: "dispatch", node, index, resume: false };
    }
    if (state.status === "interrupted") {
      return { kind: "dispatch", node, index, resume: true };
    }
    if (WAITING.has(state.status)) {
      return { kind: "wait", node, status: state.status };
    }
    if (FAILED.has(state.status)) {
      return { kind: "failed", node, status: state.status };
    }
    if (state.status === "skipped") {
      continue;
    }
    if (state.status === "succeeded") {
      if (!state.hasOutput) return { kind: "failed", node, status: state.status };
    }
  }
  return { kind: "complete" };
}
