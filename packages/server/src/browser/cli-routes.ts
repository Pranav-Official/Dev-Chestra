import type { CliListItem, CliListResponse } from "@relay/api";
import { PROD_CLIS } from "@relay/schema";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";

const LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "Opencode",
  pi: "Pi",
  fake: "Fake (test only)",
};

function isFakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RELAY_ALLOW_FAKE;
  return value === "1" || value === "true";
}

/** Static registry list. No live probes: availability is resolved client-side. */
// ponytail: labels live here; add per-CLI metadata only if the UI needs it.
export function listRegistryClis(env: NodeJS.ProcessEnv = process.env): CliListItem[] {
  const ids = [...PROD_CLIS, ...(isFakeEnabled(env) ? (["fake"] as const) : [])];
  return ids.map((id) => ({
    id,
    label: LABELS[id] ?? id,
    experimental: id !== "fake",
  }));
}

export interface CliRouteDeps {
  validate: (name: string, value: unknown) => void;
  env?: NodeJS.ProcessEnv;
}

export function mountCliRoutes(app: Hono, deps: CliRouteDeps): void {
  app.get("/api/clis", (c: Context) => {
    if (new URL(c.req.url).search !== "") {
      return c.json(errorBody("E_VALIDATION", "CLI routes do not accept query data."), 400);
    }
    const body: CliListResponse = { clis: listRegistryClis(deps.env) };
    deps.validate("CliListResponse", body);
    return c.json(body);
  });
}
