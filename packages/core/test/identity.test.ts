import { describe, expect, it } from "vitest";
import {
  createExecutionIdentity,
  createToolCallReceiptKey,
  DevChestraError,
  formatPath,
  isCurrentInvocation,
  isStaleCallback,
  type NodeId,
  nextAttempt,
  nextGeneration,
  type RunId,
  sameExecution,
  sameToolCallReceiptKey,
} from "../src/index.js";

const run = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;
const otherRun = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as RunId;
const path = formatPath([{ node: "agent" as NodeId }]);
const otherPath = formatPath([{ node: "other" as NodeId }]);

describe("execution identity", () => {
  it("compares all four identity fields exactly", () => {
    const identity = createExecutionIdentity(run, path, 2, 3);
    expect(sameExecution(identity, { ...identity })).toBe(true);
    expect(isCurrentInvocation(identity, { ...identity })).toBe(true);
    expect(sameExecution(identity, { ...identity, generation: 4 })).toBe(false);
    expect(sameExecution(identity, { ...identity, attempt: 1 })).toBe(false);
    expect(sameExecution(identity, { ...identity, path: otherPath })).toBe(false);
    expect(sameExecution(identity, { ...identity, runId: otherRun })).toBe(false);
  });

  it("authorizes only the exact current invocation, including future generations", () => {
    const current = createExecutionIdentity(run, path, 2, 3);
    expect(isCurrentInvocation({ ...current, generation: 4 }, current)).toBe(false);
    expect(isCurrentInvocation({ ...current, attempt: 3, generation: 1 }, current)).toBe(false);
    expect(isCurrentInvocation({ ...current, path: otherPath }, current)).toBe(false);
    expect(isCurrentInvocation({ ...current, runId: otherRun }, current)).toBe(false);
  });

  it("exposes a stale helper that is not an authorization decision", () => {
    const current = createExecutionIdentity(run, path, 2, 3);
    expect(isStaleCallback({ ...current, generation: 2 }, current)).toBe(true);
    expect(isStaleCallback({ ...current, attempt: 1, generation: 9 }, current)).toBe(true);
    expect(isStaleCallback({ ...current, path: otherPath }, current)).toBe(true);
    expect(isStaleCallback({ ...current, generation: 4 }, current)).toBe(false);
  });

  it("advances generation within an attempt and resets it for a new attempt", () => {
    const identity = createExecutionIdentity(run, path, 2, 3);
    expect(nextGeneration(identity)).toEqual({ ...identity, generation: 4 });
    expect(nextAttempt(identity)).toEqual({ ...identity, attempt: 3, generation: 1 });
  });

  it("distinguishes a transport retry from a fresh model call by callId", () => {
    const identity = createExecutionIdentity(run, path, 1, 1);
    const first = createToolCallReceiptKey(identity, "call-1");
    const retry = createToolCallReceiptKey({ ...identity }, "call-1");
    const fresh = createToolCallReceiptKey(identity, "call-2");
    expect(sameToolCallReceiptKey(first, retry)).toBe(true);
    expect(sameToolCallReceiptKey(first, fresh)).toBe(false);
    expect(() => createToolCallReceiptKey(identity, "")).toThrow(DevChestraError);
  });

  it("rejects non-positive or unsafe attempts and generations", () => {
    expect(() => createExecutionIdentity(run, path, 0, 1)).toThrow(DevChestraError);
    expect(() => createExecutionIdentity(run, path, 1, 0)).toThrow(DevChestraError);
    expect(() => createExecutionIdentity(run, path, 1.5, 1)).toThrow(DevChestraError);
  });
});
