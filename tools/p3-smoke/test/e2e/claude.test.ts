import { beforeAll, describe, expect, it } from "vitest";
import { runClaudeBrowserScenario } from "../../src/browser-claude.js";
import { ensurePrereqs } from "../../src/prereqs.js";

beforeAll(() => {
  ensurePrereqs({ browser: true });
});

describe("Claude model discovery browser acceptance", () => {
  it("loads dynamic SDK models, selects/saves/runs the exact value and fences stale requests", async () => {
    const evidence = await runClaudeBrowserScenario();
    expect(evidence.coldLoadGetOnly).toBe(true);
    expect(evidence.coldLoadNoSpawn).toBe(true);
    expect(evidence.loadButtonNormalClick).toBe(true);
    expect(evidence.sourceClaudeSdk).toBe(true);
    expect(evidence.dynamicModelsShown).toBe(true);
    expect(evidence.exactValueNotResolved).toBe(true);
    expect(evidence.noHardcodedAliases).toBe(true);
    expect(evidence.fuzzyCasePunctuation).toBe(true);
    expect(evidence.fuzzySubsequence).toBe(true);
    expect(evidence.selectExactValue).toBe(true);
    expect(evidence.saveReload).toBe(true);
    expect(evidence.undoRedo).toBe(true);
    expect(evidence.keyboardSelect).toBe(true);
    expect(evidence.defaultClearsModel).toBe(true);
    expect(evidence.customSelection).toBe(true);
    expect(evidence.unknownSurvivesFailure).toBe(true);
    expect(evidence.crossCliFenced).toBe(true);
    expect(evidence.run202).toBe(true);
    expect(evidence.exactModelOnArgv).toBe(true);
    expect(evidence.noDiscoveryPromptOnRun).toBe(true);
    expect(evidence.testHomePreserved).toBe(true);
    expect(evidence.sentinelsUnchanged).toBe(true);
    expect(evidence.axeSerious).toEqual({ light: 0, dark: 0, narrow: 0 });
    expect(evidence.axeTotal).toEqual({ light: 0, dark: 0, narrow: 0 });
  }, 300_000);
});
