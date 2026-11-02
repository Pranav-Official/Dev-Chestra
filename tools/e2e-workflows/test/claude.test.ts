import { beforeAll, describe, expect, it } from "vitest";
import { ensurePrereqs } from "../src/prereqs.js";
import { runClaudeHttpScenario } from "../src/scenario-claude.js";

beforeAll(() => {
  ensurePrereqs({ browser: false });
});

describe("Claude SDK model discovery HTTP acceptance", () => {
  it("is cold-unavailable with no spawn, then refreshes the actual SDK stand-in safely", async () => {
    const evidence = await runClaudeHttpScenario();
    expect(evidence.coldUnavailable).toBe(true);
    expect(evidence.coldNoSpawn).toBe(true);
    expect(evidence.queryRejected).toBe(400);
    expect(evidence.bodyRejected).toBe(400);
    expect(evidence.missingCsrfRejected).toBe(403);
    expect(evidence.oneChildPerRefresh).toBe(true);
    expect(evidence.readyStatus).toBe("ready");
    expect(evidence.source).toBe("claude-sdk");
    expect(evidence.cliVersion).toBe("2.1.310");
    expect(evidence.dynamicIds).toEqual([
      "claude-qa-n1",
      "claude-qa-n1-punctuation.v2",
      "claude-qa-n1-unicode-é",
    ]);
    expect(evidence.changedOnSecondRefresh).toBe(true);
    expect(evidence.exactValueNotResolved).toBe(true);
    expect(evidence.framesInitializeOnly).toBe(true);
    expect(evidence.noUserFrame).toBe(true);
    expect(evidence.neutralCwd).toBe(true);
    expect(evidence.dataDirScope).toBe(true);
    expect(evidence.contextPreserved).toBe(true);
    expect(evidence.cacheHitNoSpawn).toBe(true);
    expect(evidence.contextInvalidated).toBe(true);
    expect(evidence.singleFlightOneChild).toBe(true);
    expect(evidence.staleKeepsItems).toBe(true);
    expect(evidence.cooldownNoStampede).toBe(true);
    expect(evidence.timeoutBoundedMs).toBeLessThan(20_000);
    expect(["unavailable", "unsupported"]).toContain(evidence.timeoutStatus);
    expect(evidence.truncated).toBe(false);
    expect(evidence.apiClientReady).toBe(true);
    expect(evidence.safeMessages).toBe(true);
    expect(evidence.sentinelsUnchanged).toBe(true);
  }, 300_000);
});
