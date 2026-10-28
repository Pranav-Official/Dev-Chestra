import { beforeAll, describe, expect, it } from "vitest";
import { ensurePrereqs } from "../src/prereqs.js";
import { runModelHttpScenario } from "../src/scenario-models.js";

beforeAll(() => {
  ensurePrereqs({ browser: false });
});

describe("model catalog HTTP acceptance", () => {
  it("serves cache-only GET, bounded metadata refresh and stale-safe catalogs", async () => {
    const evidence = await runModelHttpScenario();
    expect(evidence.coldGetNoSpawn).toBe(true);
    expect(evidence.cachedGetNoSpawn).toBe(true);
    expect(evidence.claudeColdUnavailable).toBe(true);
    expect(evidence.fakeRejected).toBe(400);
    expect(evidence.opencodeReady).toBe(true);
    expect(evidence.piReady).toBe(true);
    expect(evidence.queryRejected).toBe(400);
    expect(evidence.bodyRejected).toBe(400);
    expect(evidence.readyStatus).toBe("ready");
    expect(evidence.paginationMerged).toBe(true);
    expect(evidence.rawModelDiffIncluded).toBe(true);
    expect(evidence.rawIdExcluded).toBe(true);
    expect(evidence.onlyMetadataRpc).toBe(true);
    expect(evidence.noClaudeSpawn).toBe(true);
    expect(evidence.noModelTurn).toBe(true);
    expect(evidence.neutralCwd).toBe(true);
    expect(evidence.testHomePreserved).toBe(true);
    expect(evidence.sentinelsUnchanged).toBe(true);
    expect(evidence.truncated).toBe(true);
    expect(evidence.staleKeptItems).toBe(true);
    expect(evidence.cooldownNoStampede).toBe(true);
    expect(evidence.apiClientReady).toBe(true);
    expect(evidence.safeMessages).toBe(true);
  }, 180_000);
});
