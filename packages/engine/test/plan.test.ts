import { describe, expect, it } from "vitest";
import {
  canOverrideUncertain,
  canRetryCrash,
  crashBudgetLeft,
  decideNextAttempt,
  shouldPauseUncertainShell,
} from "../src/plan.js";

const base = {
  hasSession: true,
  sameCwd: true,
  crashAttempts: 1,
  crashLimit: 2,
  noSubmitAttempts: 0,
  noSubmitLimit: 1,
  acceptFreshFallback: true,
};

describe("attempt planning", () => {
  it("resumes a session on crash until the persistent cap is consumed", () => {
    expect(decideNextAttempt({ ...base, failure: { kind: "crash" } })).toEqual({
      action: "resume",
      reason: "crash",
    });
    expect(decideNextAttempt({ ...base, failure: { kind: "crash" }, crashAttempts: 2 })).toEqual({
      action: "resume",
      reason: "crash",
    });
    expect(decideNextAttempt({ ...base, failure: { kind: "crash" }, crashAttempts: 3 })).toEqual({
      action: "fail",
      code: "E_CLI_CRASH",
      reason: "crash",
    });
    expect(canRetryCrash(2, 2)).toBe(true);
    expect(canRetryCrash(3, 2)).toBe(false);
    expect(crashBudgetLeft(1, 2)).toBe(1);
  });

  it("falls back to a fresh process when no resumable session exists", () => {
    expect(decideNextAttempt({ ...base, failure: { kind: "crash" }, hasSession: false })).toEqual({
      action: "fresh",
      reason: "crash_no_session",
    });
    expect(decideNextAttempt({ ...base, failure: { kind: "crash" }, sameCwd: false })).toEqual({
      action: "fresh",
      reason: "crash_no_session",
    });
    expect(
      decideNextAttempt({
        ...base,
        failure: { kind: "timeout" },
        hasSession: false,
        acceptFreshFallback: false,
      }),
    ).toEqual({ action: "fail", code: "E_ATTEMPTS_EXHAUSTED", reason: "timeout_no_session" });
  });

  it("bounds no-submit resume fallback", () => {
    expect(decideNextAttempt({ ...base, failure: { kind: "no_submit" } })).toEqual({
      action: "resume",
      reason: "no_submit",
    });
    expect(
      decideNextAttempt({ ...base, failure: { kind: "no_submit" }, noSubmitAttempts: 1 }),
    ).toEqual({ action: "fail", code: "E_ATTEMPTS_EXHAUSTED", reason: "no_submit" });
  });

  it("does not spend crash budget on validation, quota or cancellation", () => {
    expect(
      decideNextAttempt({ ...base, failure: { kind: "validation_exhausted" }, crashAttempts: 99 }),
    ).toEqual({ action: "fail", code: "E_ATTEMPTS_EXHAUSTED", reason: "validation" });
    expect(decideNextAttempt({ ...base, failure: { kind: "quota" } })).toEqual({
      action: "stop",
      reason: "quota",
    });
    expect(decideNextAttempt({ ...base, failure: { kind: "cancelled" } })).toEqual({
      action: "stop",
      reason: "cancelled",
    });
  });

  it("pauses only interrupted, unaccepted shell executions and requires explicit override", () => {
    expect(shouldPauseUncertainShell({ kind: "shell", interrupted: true, accepted: false })).toBe(
      true,
    );
    expect(shouldPauseUncertainShell({ kind: "shell", interrupted: false, accepted: false })).toBe(
      false,
    );
    expect(shouldPauseUncertainShell({ kind: "agent", interrupted: true, accepted: false })).toBe(
      false,
    );
    expect(
      canOverrideUncertain({
        pausedReason: "uncertain_side_effect",
        allowUncertainSideEffectRetry: true,
      }),
    ).toBe(true);
    expect(
      canOverrideUncertain({
        pausedReason: "uncertain_side_effect",
        allowUncertainSideEffectRetry: false,
      }),
    ).toBe(false);
    expect(
      canOverrideUncertain({ pausedReason: "shutdown", allowUncertainSideEffectRetry: true }),
    ).toBe(false);
  });
});
