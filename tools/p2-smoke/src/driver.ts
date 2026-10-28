import { ensurePrereqs, type PrereqState } from "./prereqs.js";
import { type BrowserEvidence, runBrowserScenario } from "./scenario-browser.js";
import { type LiveEvidence, runLiveScenario } from "./scenario-live.js";
import { type NegativeEvidence, runNegativeScenario } from "./scenario-negative.js";
import { type PagingEvidence, runPagingScenario } from "./scenario-paging.js";
import { runShutdownScenario, type ShutdownEvidence } from "./scenario-shutdown.js";

export type ScenarioName = "live" | "paging" | "negative" | "shutdown" | "browser" | "all";

export interface P2Summary {
  ok: true;
  scenario: ScenarioName;
  platform: string;
  node: string;
  prereqs: PrereqState;
  live?: LiveEvidence;
  shutdown?: ShutdownEvidence;
  paging?: PagingEvidence;
  negative?: NegativeEvidence;
  browser?: BrowserEvidence;
  notes: string[];
}

export interface P2Options {
  scenario: ScenarioName;
}

export async function runP2(options: P2Options): Promise<P2Summary> {
  const browser = options.scenario === "browser" || options.scenario === "all";
  const prereqs = ensurePrereqs({ browser });
  const summary: P2Summary = {
    ok: true,
    scenario: options.scenario,
    platform: process.platform,
    node: process.versions.node,
    prereqs,
    notes: [],
  };

  if (options.scenario === "live" || options.scenario === "all") {
    summary.live = await runLiveScenario();
  }
  if (options.scenario === "paging" || options.scenario === "all") {
    summary.paging = await runPagingScenario();
  }
  if (options.scenario === "negative" || options.scenario === "all") {
    summary.negative = await runNegativeScenario();
  }
  if (options.scenario === "shutdown" || options.scenario === "all") {
    summary.shutdown = await runShutdownScenario();
  }
  if (browser) {
    summary.browser = await runBrowserScenario();
    if (summary.browser.axeSerious > 0) {
      throw new Error(
        `axe reported serious/critical violations on the run page: ${JSON.stringify(
          summary.browser.axeViolations,
        )}`,
      );
    }
  }

  summary.notes.push(
    "All runs use a temporary SQLite data dir and a real `devchestra start` child; no route handlers are mocked.",
  );
  summary.notes.push(
    "SSE overflow at production queueLimit=5000 is not driven through the public server; the stream hub owns that bounded test.",
  );
  summary.notes.push(
    "Paid model CLIs are never invoked; only the trusted fake agent and shell nodes run.",
  );
  return summary;
}
