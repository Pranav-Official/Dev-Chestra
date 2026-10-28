import { listProviders } from "@relay/adapters";
import type { CliListItem, CliListResponse } from "@relay/api";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";

/** Registry-backed CLI list. Ids and labels come from the provider registry
 * (`CliProvider.id`/`CliProvider.label`); the fake provider is included only
 * behind RELAY_ALLOW_FAKE. No live probes: availability is resolved client-side. */
export function listRegistryClis(): CliListItem[] {
  return listProviders().map((provider) => ({
    id: provider.id,
    label: provider.label,
    experimental: provider.experimental,
  }));
}

export interface CliRouteDeps {
  validate: (name: string, value: unknown) => void;
}

export function mountCliRoutes(app: Hono, deps: CliRouteDeps): void {
  app.get("/api/clis", (c: Context) => {
    if (new URL(c.req.url).search !== "") {
      return c.json(errorBody("E_VALIDATION", "CLI routes do not accept query data."), 400);
    }
    const body: CliListResponse = { clis: listRegistryClis() };
    deps.validate("CliListResponse", body);
    return c.json(body);
  });
}
