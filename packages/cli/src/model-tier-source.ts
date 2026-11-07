import { DevChestraError, err, ok } from "@devchestra/core";
import type { ModelTierSource } from "@devchestra/engine";
import { loadEffectiveModelTiers } from "@devchestra/server";

/**
 * Reads the project's model-tier mapping (committed settings merged with the machine-local
 * file) from its folder each time a run launches, so a settings edit applies to the next run.
 */
export function createModelTierSource(store: {
  projects: { get(projectId: string): { path: string } | null };
}): ModelTierSource {
  return {
    async load(projectId) {
      const project = store.projects.get(projectId);
      if (project === null) {
        return err(new DevChestraError("E_NOT_FOUND", `Project '${projectId}' was not found.`));
      }
      try {
        return ok(loadEffectiveModelTiers(project.path));
      } catch (error) {
        return err(
          new DevChestraError(
            "E_MODEL_TIER",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  };
}
