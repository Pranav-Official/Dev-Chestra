import { beforeAll, describe, expect, it } from "vitest";
import { runRawBrowserScenario } from "../../src/browser-raw.js";
import { ensurePrereqs } from "../../src/prereqs.js";

beforeAll(() => {
  ensurePrereqs({ browser: true });
});

describe("P3 raw JSON browser acceptance", () => {
  it("creates, saves, reloads and runs a raw output workflow", async () => {
    const evidence = await runRawBrowserScenario();
    expect(evidence.rawModeDefault).toBe(true);
    expect(evidence.canonicalRawSchema).toBe(true);
    expect(evidence.saveReloadStable).toBe(true);
    expect(evidence.run202).toBe(true);
    expect(evidence.unknownRecordVisible).toBe(true);
    expect(evidence.anyFieldSaved).toBe(true);
    expect(evidence.rawAxeSerious).toBe(0);
  }, 240_000);
});
