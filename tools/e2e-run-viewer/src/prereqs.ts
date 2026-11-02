import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLI, REPO_ROOT } from "./fixtures.js";
import { chromiumPath } from "./scenario-browser.js";

export interface PrereqState {
  cli: boolean;
  web: boolean;
  shim: boolean;
  fakeAgent: boolean;
  chromium: string;
}

export function inspectPrereqs(): PrereqState {
  return {
    cli: existsSync(CLI),
    web: existsSync(join(REPO_ROOT, "apps/web/dist/index.html")),
    shim: existsSync(join(REPO_ROOT, "packages/mcp/dist/bin/shim.js")),
    fakeAgent: existsSync(join(REPO_ROOT, "tools/fake-agent/dist/main.js")),
    chromium: chromiumPath(),
  };
}

/** Missing build outputs or a browser must fail loudly; never skip a green test. */
export function ensurePrereqs(options: { browser: boolean }): PrereqState {
  const state = inspectPrereqs();
  const missing: string[] = [];
  if (!state.cli) missing.push("packages/cli/dist/main.js");
  if (!state.web) missing.push("apps/web/dist/index.html");
  if (!state.shim) missing.push("packages/mcp/dist/bin/shim.js");
  if (!state.fakeAgent) missing.push("tools/fake-agent/dist/main.js");
  if (options.browser && !existsSync(state.chromium)) {
    missing.push(`chromium at DEVCHESTRA_CHROMIUM_PATH || ${state.chromium}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `acceptance prerequisites are missing: ${missing.join(", ")}. Run "pnpm build" and provide Chromium.`,
    );
  }
  return state;
}
