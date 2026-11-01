import { getProvider, listProviders } from "@devchestra/adapters";
import {
  type CatalogCli,
  type CliListItem,
  type CliListResponse,
  type CliStatusResponse,
  catalogCliSchema,
  type ProviderStatusItem,
  updateCliRequestSchema,
} from "@devchestra/api";
import { PROD_CLIS } from "@devchestra/schema";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import { hasRequestBody, rejectsQuery } from "./model-routes.js";
import type { BrowserProviderSettingsPort } from "./ports.js";
import type { ProviderStatusService } from "./provider-status.js";
import { readJsonObject } from "./security.js";

const MAX_JSON_BYTES = 1024;
const QUERY_MESSAGE = "CLI routes do not accept query data.";

function listItem(
  provider: { id: string; label: string; experimental: boolean },
  disabled: ReadonlySet<string>,
): CliListItem {
  return {
    id: provider.id,
    label: provider.label,
    experimental: provider.experimental,
    // The fake provider is test-only and cannot be turned off.
    enabled: provider.id === "fake" || !disabled.has(provider.id),
  };
}

/** Registry-backed CLI list. Ids and labels come from the provider registry
 * (`CliProvider.id`/`CliProvider.label`); the fake provider is included only
 * behind DEVCHESTRA_ALLOW_FAKE. Without a settings port every CLI is on.
 * No live probes: availability is resolved client-side. */
export function listRegistryClis(settings?: BrowserProviderSettingsPort): CliListItem[] {
  const disabled: ReadonlySet<string> = settings?.disabled() ?? new Set<string>();
  return listProviders().map((provider) => listItem(provider, disabled));
}

export interface CliRouteDeps {
  validate: (name: string, value: unknown) => void;
  providerSettings?: BrowserProviderSettingsPort;
  providerStatus?: ProviderStatusService;
}

function parseCli(c: Context): CatalogCli | null {
  const parsed = catalogCliSchema.safeParse(c.req.param("id"));
  return parsed.success ? parsed.data : null;
}

export function mountCliRoutes(app: Hono, deps: CliRouteDeps): void {
  app.get("/api/clis", (c: Context) => {
    if (rejectsQuery(c)) return c.json(errorBody("E_VALIDATION", QUERY_MESSAGE), 400);
    const body: CliListResponse = { clis: listRegistryClis(deps.providerSettings) };
    deps.validate("CliListResponse", body);
    return c.json(body);
  });

  app.get("/api/clis/status", async (c: Context) => {
    if (rejectsQuery(c)) return c.json(errorBody("E_VALIDATION", QUERY_MESSAGE), 400);
    const status = deps.providerStatus;
    if (status === undefined) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Provider status is not available."), 501);
    }
    const body: CliStatusResponse = { statuses: await status.getAll() };
    deps.validate("CliStatusResponse", body);
    return c.json(body);
  });

  app.patch("/api/clis/:id", async (c: Context) => {
    if (rejectsQuery(c)) return c.json(errorBody("E_VALIDATION", QUERY_MESSAGE), 400);
    const cli = parseCli(c);
    if (cli === null) return c.json(errorBody("E_VALIDATION", "CLI is not supported."), 400);
    const settings = deps.providerSettings;
    if (settings === undefined) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Provider settings are not available."), 501);
    }
    const parsed = updateCliRequestSchema.safeParse(
      await readJsonObject(c, { maxBytes: MAX_JSON_BYTES }),
    );
    if (!parsed.success) {
      return c.json(errorBody("E_VALIDATION", "Provider settings body is invalid."), 400);
    }
    const { enabled } = parsed.data;
    const disabled = settings.disabled();
    const currentlyEnabled = !disabled.has(cli);
    if (enabled !== currentlyEnabled) {
      if (!enabled) {
        const remaining = PROD_CLIS.filter((id) => id !== cli && !disabled.has(id));
        if (remaining.length === 0) {
          return c.json(errorBody("E_CONFLICT", "At least one provider must stay on."), 409);
        }
      }
      settings.setEnabled(cli, enabled);
    }
    const body = listItem(getProvider(cli), settings.disabled());
    deps.validate("CliListItem", body);
    return c.json(body);
  });

  app.post("/api/clis/:id/probe", async (c: Context) => {
    if (rejectsQuery(c)) return c.json(errorBody("E_VALIDATION", QUERY_MESSAGE), 400);
    if (await hasRequestBody(c)) {
      return c.json(errorBody("E_VALIDATION", "Request body is not allowed."), 400);
    }
    const cli = parseCli(c);
    if (cli === null) return c.json(errorBody("E_VALIDATION", "CLI is not supported."), 400);
    const status = deps.providerStatus;
    if (status === undefined) {
      return c.json(errorBody("E_NOT_SUPPORTED", "Provider status is not available."), 501);
    }
    const body: ProviderStatusItem = await status.probe(cli, { fresh: true });
    deps.validate("ProviderStatusItem", body);
    return c.json(body);
  });
}
