import { DevChestraError } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import { exitCodeForError, exitCodeForOutcome } from "../src/output.js";

describe("CLI exit codes", () => {
  it("maps a failed join conflict to the controlled validation exit", () => {
    expect(
      exitCodeForOutcome({
        runId: "run",
        status: "failed",
        error: { code: "E_JOIN_CONFLICT", message: "join conflict" },
      }),
    ).toBe(4);
  });

  it("maps multiple active ends (E_WORKFLOW_INVALID) to the same exit", () => {
    expect(
      exitCodeForOutcome({
        runId: "run",
        status: "failed",
        error: { code: "E_WORKFLOW_INVALID", message: "multiple active End nodes" },
      }),
    ).toBe(4);
  });

  it("keeps ordinary run failures and gate evaluation failures at exit 1", () => {
    expect(
      exitCodeForOutcome({
        runId: "run",
        status: "failed",
        error: { code: "E_EXPR", message: "gate when was not a boolean" },
      }),
    ).toBe(1);
    expect(exitCodeForOutcome({ runId: "run", status: "failed" })).toBe(1);
  });

  it("maps a thrown E_JOIN_CONFLICT to exit 4", () => {
    expect(exitCodeForError(new DevChestraError("E_JOIN_CONFLICT", "conflict"))).toBe(4);
  });
});
