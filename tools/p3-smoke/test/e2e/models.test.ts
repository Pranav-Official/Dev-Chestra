import { beforeAll, describe, expect, it } from "vitest";
import { runModelBrowserScenario } from "../../src/browser-models.js";
import { ensurePrereqs } from "../../src/prereqs.js";

beforeAll(() => {
  ensurePrereqs({ browser: true });
});

describe("model selector browser acceptance", () => {
  it("filters, selects, saves, fences and runs the exact model id", async () => {
    const evidence = await runModelBrowserScenario();
    expect(evidence.coldOpenGetOnly).toBe(true);
    expect(evidence.coldOpenNoSpawn).toBe(true);
    expect(evidence.typingNoMutation).toBe(true);
    expect(evidence.escapeNoCommit).toBe(true);
    expect(evidence.refreshPostOnly).toBe(true);
    expect(evidence.metadataRpcOnly).toBe(true);
    expect(evidence.noClaudeSpawn).toBe(true);
    expect(evidence.paginationCount).toBe(6);
    expect(evidence.fuzzyCasePunctuation).toBe(true);
    expect(evidence.fuzzySubsequence).toBe(true);
    expect(evidence.defaultClearsModel).toBe(true);
    expect(evidence.customSelection).toBe(true);
    expect(evidence.keyboardSelect).toBe(true);
    expect(evidence.saveReload).toBe(true);
    expect(evidence.undoRedo).toBe(true);
    expect(evidence.cliChangeOneUndo).toBe(true);
    expect(evidence.crossCliFenced).toBe(true);
    expect(evidence.unknownSurvivesFailure).toBe(true);
    expect(evidence.boundedFailureMs).toBeLessThan(20_000);
    expect(evidence.pickerKeysDoNotDelete).toBe(true);
    expect(evidence.run202).toBe(true);
    expect(evidence.exactModelOnArgv).toBe(true);
    expect(evidence.testHomePreserved).toBe(true);
    expect(evidence.sentinelsUnchanged).toBe(true);
    expect(evidence.axeSerious).toEqual({ light: 0, dark: 0, narrow: 0 });
    expect(evidence.axeTotal).toEqual({ light: 0, dark: 0, narrow: 0 });
  }, 300_000);
});
