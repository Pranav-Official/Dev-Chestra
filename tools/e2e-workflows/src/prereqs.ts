import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromiumPath } from "./chromium.js";
import { CLI, FAKE_AGENT, MCP_SHIM, WEB_INDEX } from "./fixtures.js";

const require = createRequire(import.meta.url);

export interface PrereqState {
  cli: boolean;
  web: boolean;
  shim: boolean;
  fakeAgent: boolean;
  sqlite: boolean;
  chromium: string;
}

function hasNodeSqlite(): boolean {
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === "function";
  } catch {
    return false;
  }
}

export function inspectPrereqs(): PrereqState {
  return {
    cli: existsSync(CLI),
    web: existsSync(WEB_INDEX),
    shim: existsSync(MCP_SHIM),
    fakeAgent: existsSync(FAKE_AGENT),
    sqlite: hasNodeSqlite(),
    chromium: chromiumPath(),
  };
}

export function ensurePrereqs(options: { browser: boolean }): PrereqState {
  const state = inspectPrereqs();
  const missing: string[] = [];
  if (!state.cli) missing.push("packages/cli/dist/main.js");
  if (!state.web) missing.push("apps/web/dist/index.html");
  if (!state.shim) missing.push("packages/mcp/dist/bin/shim.js");
  if (!state.fakeAgent) missing.push("tools/fake-agent/dist/main.js");
  if (!state.sqlite) missing.push("node:sqlite DatabaseSync");
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
