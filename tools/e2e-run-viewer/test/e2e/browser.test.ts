import { beforeAll, describe, expect, it } from "vitest";
import { ensurePrereqs } from "../../src/prereqs.js";
import { runBrowserScenario } from "../../src/scenario-browser.js";

beforeAll(() => {
  ensurePrereqs({ browser: true });
});

describe("browser acceptance", () => {
  it("keeps the headless run alive across tabs and replays without HTML injection", async () => {
    const evidence = await runBrowserScenario();
    expect(evidence.urlHadNoToken).toBe(true);
    expect(evidence.tabCloseReopen).toBe(true);
    expect(evidence.themeKeyboard).toBe(true);
    expect(evidence.reconnectBanner).toBe(true);
    expect(evidence.replayMatched).toBe(true);
    expect(evidence.backToLive).toBe(true);
    expect(evidence.htmlEscaped).toBe(true);
    expect(evidence.axeSerious).toBe(0);
    expect(evidence.screenshots.light).toContain("run-light-1440x900.png");
    expect(evidence.screenshots.dark).toContain("run-dark-1440x900.png");
    expect(evidence.screenshots.narrow).toContain("run-narrow-390x844.png");
  }, 180_000);
});
