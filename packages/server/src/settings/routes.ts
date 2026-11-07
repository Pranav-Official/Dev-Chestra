import {
  type EffectiveSettingsResponse,
  type SettingsResponse,
  settingsDocumentSchema,
  settingsScopeSchema,
} from "@devchestra/api";
import { MODEL_TIERS, mergeModelTiers, type SettingsFile } from "@devchestra/schema";
import type { Context, Hono } from "hono";
import type { BrowserQueryPort, ProjectView } from "../browser/ports.js";
import { readJsonObject } from "../browser/security.js";
import { assertProjectPathAllowed } from "../browser/workflow.js";
import { DevChestraError, errorBody } from "../errors.js";
import { parseIfMatch, quoteEtag } from "../workflows/io.js";
import { readSettingsLayer, type SettingsLayer, saveSettingsLayer } from "./store.js";

const MAX_SETTINGS_JSON_BYTES = 64 * 1024;

export interface SettingsRouteDeps {
  store: BrowserQueryPort;
  dataDir: string;
  validate: (name: string, value: unknown) => void;
}

function layerBody(layer: SettingsLayer): SettingsResponse {
  return {
    scope: layer.scope,
    document: layer.document as SettingsResponse["document"],
    etag: layer.etag,
    exists: layer.exists,
    warnings: layer.warnings,
  };
}

/** Settings that live in a project's `.devchestra/` folder: committed `settings` and machine-local `settings.local`. */
export function mountSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  const projectRoot = async (
    c: Context,
  ): Promise<{ root: string; project: ProjectView } | Response> => {
    const project = await deps.store.getProject(c.req.param("pid") ?? "");
    if (project === null) return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    if (project.missing) {
      return c.json(
        errorBody(
          "E_CONFLICT",
          "Project path is missing; relink the project before editing settings.",
        ),
        409,
      );
    }
    return { root: assertProjectPathAllowed(project.path, deps.dataDir), project };
  };

  app.get("/api/projects/:pid/settings/effective", async (c) => {
    const found = await projectRoot(c);
    if (found instanceof Response) return found;
    const tiers = mergeModelTiers(
      readSettingsLayer(found.root, "project").document,
      readSettingsLayer(found.root, "local").document,
    );
    const body: EffectiveSettingsResponse = {
      tiers: MODEL_TIERS.map((tier) => {
        const mapped = tiers[tier];
        return {
          tier,
          mapping: mapped === undefined ? null : { ref: mapped.ref, source: mapped.source },
        };
      }),
    };
    deps.validate("EffectiveSettingsResponse", body);
    return c.json(body);
  });

  app.get("/api/projects/:pid/settings/:scope", async (c) => {
    const scope = settingsScopeSchema.safeParse(c.req.param("scope"));
    if (!scope.success) return c.json(errorBody("E_NOT_FOUND", "Unknown settings scope."), 404);
    const found = await projectRoot(c);
    if (found instanceof Response) return found;
    const body = layerBody(readSettingsLayer(found.root, scope.data));
    deps.validate("SettingsResponse", body);
    c.header("ETag", quoteEtag(body.etag));
    return c.json(body);
  });

  app.put("/api/projects/:pid/settings/:scope", async (c) => {
    const scope = settingsScopeSchema.safeParse(c.req.param("scope"));
    if (!scope.success) return c.json(errorBody("E_NOT_FOUND", "Unknown settings scope."), 404);
    const found = await projectRoot(c);
    if (found instanceof Response) return found;
    const raw = await readJsonObject(c, { maxBytes: MAX_SETTINGS_JSON_BYTES });
    const parsed = settingsDocumentSchema.safeParse(raw);
    if (!parsed.success) return c.json(errorBody("E_VALIDATION", "Settings body is invalid."), 400);
    const expected = parseIfMatch(c.req.header("If-Match"));
    try {
      const saved = await saveSettingsLayer(
        found.root,
        scope.data,
        parsed.data as SettingsFile,
        expected,
      );
      const body = layerBody(saved);
      deps.validate("SettingsResponse", body);
      c.header("ETag", quoteEtag(body.etag));
      return c.json(body);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_CONFLICT") {
        const currentEtag = (error.details as { currentEtag?: unknown } | undefined)?.currentEtag;
        if (typeof currentEtag === "string") c.header("ETag", quoteEtag(currentEtag));
        return c.json(errorBody("E_CONFLICT", error.message, error.details), 409);
      }
      throw error;
    }
  });
}
