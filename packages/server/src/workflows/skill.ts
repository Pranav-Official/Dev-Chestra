import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalExistingDirectory } from "../browser/workflow.js";
import { DevChestraError } from "../errors.js";
import { ensureManagedDirectory, publishNewFile } from "./io.js";

/** Agent-facing authoring guide, seeded once per project at `.devchestra/skill.md`. */
export const PROJECT_SKILL_FILE = "skill.md";
export const PROJECT_SKILL_RELATIVE_FILE = `.devchestra/${PROJECT_SKILL_FILE}`;

/**
 * The guide ships as a package asset (`packages/server/assets`) so it stays a
 * reviewable Markdown file. The relative URL resolves identically from `src/`
 * (tests, tsx) and from `dist/` (built CLI and server).
 */
const SKILL_TEMPLATE_URL = new URL("../../assets/devchestra-skill.md", import.meta.url);

let cachedTemplate: Buffer | undefined;

export function projectSkillTemplate(): Buffer {
  cachedTemplate ??= readFileSync(fileURLToPath(SKILL_TEMPLATE_URL));
  return Buffer.from(cachedTemplate);
}

export interface ProjectSkillResult {
  /** Absolute path of the project's skill file. */
  path: string;
  relativeFile: string;
  /** True only when this call published the file; an existing file is never touched. */
  created: boolean;
}

function notRegular(): DevChestraError {
  return new DevChestraError(
    "E_FORBIDDEN_PATH",
    `${PROJECT_SKILL_RELATIVE_FILE} must be a regular file, not a symlink or directory.`,
  );
}

/** Classify `target` without following links: "absent" or "regular", else reject. */
function inspectSkillTarget(target: string): "absent" | "regular" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw notRegular();
  return "regular";
}

/**
 * Seed `<projectRoot>/.devchestra/skill.md` when it does not exist yet. The
 * project root must already exist (it is never created). An existing regular
 * file, even an empty or hand-edited one, is left byte-for-byte untouched. A
 * `.devchestra` that is a symlink or not a directory, or a `skill.md` that is a
 * symlink (including a dangling one) or not a regular file, is rejected. Real IO
 * errors propagate. Concurrent callers publish through an exclusive hard link, so
 * exactly one creates the file and the rest see it as existing.
 */
export function ensureProjectSkill(projectRoot: string): ProjectSkillResult {
  const root = canonicalExistingDirectory(projectRoot, "Project path");
  const directory = join(root, ".devchestra");
  ensureManagedDirectory(directory, root);
  const path = join(directory, PROJECT_SKILL_FILE);
  const base = { path, relativeFile: PROJECT_SKILL_RELATIVE_FILE };
  if (inspectSkillTarget(path) === "regular") return { ...base, created: false };

  const created = publishNewFile(
    directory,
    root,
    PROJECT_SKILL_FILE,
    PROJECT_SKILL_FILE,
    projectSkillTemplate(),
    0o644,
  );
  // Lost a race: whatever won must still be an ordinary file, not a planted link.
  if (!created && inspectSkillTarget(path) !== "regular") throw notRegular();
  return { ...base, created };
}
