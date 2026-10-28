import type { ErrorCode } from "@devchestra/core";

export type AttemptFailure =
  | { kind: "ok" }
  | { kind: "crash" }
  | { kind: "timeout" }
  | { kind: "context_overflow" }
  | { kind: "no_submit" }
  | { kind: "validation_exhausted" }
  | { kind: "cancelled" }
  | { kind: "quota" }
  | { kind: "auth" }
  | { kind: "rate_limit" };

export interface AttemptContext {
  readonly failure: AttemptFailure;
  readonly hasSession: boolean;
  readonly sameCwd: boolean;
  readonly crashAttempts: number;
  readonly crashLimit: number;
  readonly noSubmitAttempts: number;
  readonly noSubmitLimit: number;
  readonly acceptFreshFallback: boolean;
}

export type AttemptDecision =
  | { readonly action: "resume"; readonly reason: string }
  | { readonly action: "fresh"; readonly reason: string }
  | { readonly action: "fail"; readonly code: ErrorCode; readonly reason: string }
  | { readonly action: "stop"; readonly reason: string };

export function decideNextAttempt(ctx: AttemptContext): AttemptDecision {
  const failure = ctx.failure;
  if (failure.kind === "ok") return { action: "stop", reason: "process exited after acceptance" };
  if (failure.kind === "cancelled") return { action: "stop", reason: "cancelled" };
  if (failure.kind === "quota" || failure.kind === "auth") {
    return { action: "stop", reason: failure.kind };
  }
  if (failure.kind === "validation_exhausted") {
    return { action: "fail", code: "E_ATTEMPTS_EXHAUSTED", reason: "validation" };
  }
  if (failure.kind === "no_submit") {
    if (ctx.noSubmitAttempts >= ctx.noSubmitLimit) {
      return { action: "fail", code: "E_ATTEMPTS_EXHAUSTED", reason: "no_submit" };
    }
    return sessionAction(ctx, "no_submit");
  }
  if (ctx.crashAttempts > ctx.crashLimit) {
    return { action: "fail", code: "E_CLI_CRASH", reason: failure.kind };
  }
  if (failure.kind === "rate_limit") return sessionAction(ctx, "rate_limit");
  return sessionAction(ctx, failure.kind);
}

function sessionAction(ctx: AttemptContext, reason: string): AttemptDecision {
  if (ctx.hasSession && ctx.sameCwd) return { action: "resume", reason };
  if (ctx.acceptFreshFallback) return { action: "fresh", reason: `${reason}_no_session` };
  return { action: "fail", code: "E_ATTEMPTS_EXHAUSTED", reason: `${reason}_no_session` };
}

export function crashBudgetLeft(crashAttempts: number, crashLimit: number): number {
  return Math.max(0, crashLimit - crashAttempts);
}

export function canRetryCrash(crashAttempts: number, crashLimit: number): boolean {
  return crashAttempts <= crashLimit;
}

export function shouldPauseUncertainShell(input: {
  readonly kind: string;
  readonly interrupted: boolean;
  readonly accepted: boolean;
}): boolean {
  return input.kind === "shell" && input.interrupted && !input.accepted;
}

export function canOverrideUncertain(input: {
  readonly pausedReason: string | null | undefined;
  readonly allowUncertainSideEffectRetry: boolean | undefined;
}): boolean {
  return (
    input.allowUncertainSideEffectRetry === true && input.pausedReason === "uncertain_side_effect"
  );
}
