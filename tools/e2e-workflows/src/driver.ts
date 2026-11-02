import { type ClaudeBrowserEvidence, runClaudeBrowserScenario } from "./browser-claude.js";
import { type HandoffEvidence, runHandoffBrowserScenario } from "./browser-handoff.js";
import { type ModelBrowserEvidence, runModelBrowserScenario } from "./browser-models.js";
import { type RawEvidence, runRawBrowserScenario } from "./browser-raw.js";
import { ensurePrereqs, type PrereqState } from "./prereqs.js";
import { type ClaudeHttpEvidence, runClaudeHttpScenario } from "./scenario-claude.js";
import { type HttpEvidence, restartPersistenceScenario, runHttpScenario } from "./scenario-http.js";
import { type ModelHttpEvidence, runModelHttpScenario } from "./scenario-models.js";
import { runSecurityScenario, type SecurityEvidence } from "./scenario-security.js";

export type ScenarioName =
  | "http"
  | "security"
  | "restart"
  | "browser"
  | "raw"
  | "handoff"
  | "models"
  | "claude"
  | "all";

export interface WorkflowsSummary {
  ok: true;
  scenario: ScenarioName;
  platform: string;
  node: string;
  prereqs: PrereqState;
  http?: HttpEvidence;
  security?: SecurityEvidence;
  restart?: { sameText: boolean };
  browser?: unknown;
  raw?: RawEvidence;
  handoff?: HandoffEvidence;
  models?: { http: ModelHttpEvidence; browser: ModelBrowserEvidence };
  claude?: { http: ClaudeHttpEvidence; browser: ClaudeBrowserEvidence };
  notes: string[];
}

export interface WorkflowsOptions {
  scenario: ScenarioName;
}

export async function runP3(options: WorkflowsOptions): Promise<WorkflowsSummary> {
  const browser = options.scenario === "browser" || options.scenario === "all";
  const raw = options.scenario === "raw" || options.scenario === "all";
  const handoff = options.scenario === "handoff" || options.scenario === "all";
  const models = options.scenario === "models" || options.scenario === "all";
  const claude = options.scenario === "claude" || options.scenario === "all";
  const prereqs = ensurePrereqs({ browser: browser || raw || handoff || models || claude });
  const summary: WorkflowsSummary = {
    ok: true,
    scenario: options.scenario,
    platform: process.platform,
    node: process.versions.node,
    prereqs,
    notes: [],
  };

  if (options.scenario === "http" || options.scenario === "all") {
    summary.http = await runHttpScenario();
  }
  if (options.scenario === "security" || options.scenario === "all") {
    summary.security = await runSecurityScenario();
  }
  if (options.scenario === "restart" || options.scenario === "all") {
    summary.restart = await restartPersistenceScenario();
  }
  if (browser) {
    const { runBrowserScenario } = await import("./scenario-browser.js");
    summary.browser = await runBrowserScenario();
  }
  if (raw) {
    summary.raw = await runRawBrowserScenario();
  }
  if (handoff) {
    summary.handoff = await runHandoffBrowserScenario();
  }
  if (models) {
    summary.models = {
      http: await runModelHttpScenario(),
      browser: await runModelBrowserScenario(),
    };
  }
  if (claude) {
    summary.claude = {
      http: await runClaudeHttpScenario(),
      browser: await runClaudeBrowserScenario(),
    };
  }

  summary.notes.push(
    "Only actual `devchestra start --port 0` children are used; SQLite, MCP, fake agent and the built web app are real.",
  );
  summary.notes.push(
    "No paid provider CLI is invoked; only the trusted fake agent and shell nodes execute.",
  );
  summary.notes.push(
    "Each run uses mkdtemp and removes only its own data directory after checking pidStart identities and a sentinel.",
  );
  return summary;
}
