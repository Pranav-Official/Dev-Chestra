import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  assertRunTransition,
  assertTransition,
  canRunTransition,
  canTransition,
  EXEC_STATUSES,
  type ExecStatus,
  isTerminalExecStatus,
  isTerminalRunStatus,
  RelayError,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  type RunStatus,
} from "../src/index.js";

describe("execution transition table", () => {
  it("matches the table for every pair", () => {
    for (const from of EXEC_STATUSES) {
      for (const to of EXEC_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          ALLOWED_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it("allows every recovery and retry transition", () => {
    const recovery: [ExecStatus, ExecStatus][] = [
      ["running", "succeeded"],
      ["running", "interrupted"],
      ["validating", "succeeded"],
      ["validating", "interrupted"],
      ["interrupted", "ready"],
      ["failed", "pending"],
      ["succeeded", "pending"],
    ];
    for (const [from, to] of recovery) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("rejects illegal transitions with E_INTERNAL", () => {
    expect(canTransition("pending", "running")).toBe(false);
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(() => assertTransition("succeeded", "running")).toThrow(RelayError);
    try {
      assertTransition("pending", "running");
    } catch (error) {
      expect(error).toMatchObject({ code: "E_INTERNAL" });
    }
  });

  it("classifies terminal statuses", () => {
    for (const status of EXEC_STATUSES) {
      expect(isTerminalExecStatus(status)).toBe(
        ["succeeded", "failed", "skipped", "rejected", "cancelled"].includes(status),
      );
    }
  });
});

describe("run transition table", () => {
  it("matches the table for every pair", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canRunTransition(from, to), `${from} -> ${to}`).toBe(
          RUN_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it("rejects transitions out of terminal run states", () => {
    const terminal: RunStatus[] = ["succeeded", "failed", "rejected", "cancelled"];
    for (const from of terminal) {
      expect(isTerminalRunStatus(from)).toBe(true);
      for (const to of RUN_STATUSES) expect(canRunTransition(from, to)).toBe(false);
      expect(() => assertRunTransition(from, "running")).toThrow(RelayError);
    }
  });
});
