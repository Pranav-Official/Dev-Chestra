import { beforeAll, describe, expect, it } from "vitest";
import { ensurePrereqs } from "../../src/prereqs.js";
import { runBrowserScenario } from "../../src/scenario-browser.js";

beforeAll(() => {
  ensurePrereqs({ browser: true });
});

describe("browser authoring acceptance", () => {
  it("authors, validates, saves, runs and resolves conflicts against the real app", async () => {
    const evidence = await runBrowserScenario();
    expect(evidence.urlHadNoToken).toBe(true);
    expect(evidence.keyboardDialog).toBe(true);
    expect(evidence.keyboardCanvas).toBe(true);
    expect(evidence.strictCsp).toBe(true);
    expect(evidence.noCancelOnTabClose).toBe(true);
    expect(evidence.primary.reloadByteStable).toBe(true);
    expect(evidence.primary.layoutPersisted).toBe(true);
    expect(evidence.primary.schemaEdited).toBe(true);
    expect(evidence.primary.duplicateRejected).toBe(true);
    expect(evidence.primary.cycleRejected).toBe(true);
    expect(evidence.primary.undoRedo).toBe(true);
    expect(evidence.primary.run202).toBe(true);
    expect(evidence.primary.closeReopen).toBe(true);
    expect(evidence.primary.outputVisible).toBe(true);
    expect(evidence.primary.transcriptVisible).toBe(true);
    expect(evidence.primary.snapshotImmutable).toBe(true);
    expect(evidence.primary.incompleteSaved).toBe(true);
    expect(evidence.primary.incompleteFixedAndRan).toBe(true);
    expect(evidence.primary.axeSerious).toEqual({ list: 0, editor: 0, run: 0 });
    expect(evidence.conflicts.twoPageConflict).toBe(true);
    expect(evidence.conflicts.reloadDiscardedLocal).toBe(true);
    expect(evidence.conflicts.overwriteUsedFreshEtag).toBe(true);
    expect(evidence.conflicts.externalEditConflict).toBe(true);
    expect(evidence.conflicts.inFlightKeptLatest).toBe(true);
    expect(evidence.conflicts.invalidBufferBlockedRun).toBe(true);
    expect(evidence.conflicts.runUsedFreshSave).toBe(true);
    expect(evidence.conflicts.doubleClickOneRun).toBe(true);
  }, 300_000);
});
