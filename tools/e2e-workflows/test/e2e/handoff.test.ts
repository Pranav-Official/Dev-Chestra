import { beforeAll, describe, expect, it } from "vitest";
import { runHandoffBrowserScenario } from "../../src/browser-handoff.js";
import { ensurePrereqs } from "../../src/prereqs.js";

beforeAll(() => {
  ensurePrereqs({ browser: true });
});

describe("automatic agent input handoff", () => {
  it("feeds plain-prompt Agent 2 the accepted Agent 1 data through its real process", async () => {
    const evidence = await runHandoffBrowserScenario();
    expect(evidence.run202).toBe(true);
    expect(evidence.startNonceInAgent1Prompt).toBe(true);
    expect(evidence.agent1NonceInAgent2Prompt).toBe(true);
    expect(evidence.agent1ReposInAgent2Prompt).toBe(true);
    expect(evidence.derivedReceivedMatchesAgent1).toBe(true);
    expect(evidence.ownProtoRetained).toBe(true);
    expect(evidence.viewerShowsReceived).toBe(true);
  }, 240_000);
});
