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
 * Split skill files shipped as package assets (`packages/server/assets/skills`)
 * so the CLI can print one focused guide at a time instead of the whole manual.
 * `devchestra-skill.md` remains the concatenated legacy guide: it seeds new
 * projects and backs `devchestra skill --all`.
 */
const SKILL_TEMPLATE_URL = new URL("../../assets/devchestra-skill.md", import.meta.url);
const SKILLS_DIR_URL = new URL("../../assets/skills/", import.meta.url);

export const SKILL_NAMES = [
  "basics",
  "graph",
  "expressions",
  "nodes-core",
  "nodes-branch",
  "nodes-compose",
  "triggers",
  "ops",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  basics: "file layout, ids, minimal workflow. Start here for any new workflow.",
  graph: "graph rules and edge handles.",
  expressions: "params, outputs, JSONata templates vs bare expressions, scope.",
  "nodes-core": "start/agent/shell/end + output schemas.",
  "nodes-branch": "gate/join/approval/decision + routing example.",
  "nodes-compose": "loop/foreach/workflow calls.",
  triggers: "start.polling / start.webhook trigger blocks, arming, delivery contracts.",
  ops: "workspace safety, limits, authoring checklist, CLI lifecycle, monitoring runs (run status/wait), recovery.",
};

const skillCache = new Map<string, Buffer>();

function readSkillFile(name: string): Buffer {
  const cached = skillCache.get(name);
  if (cached !== undefined) return Buffer.from(cached);
  const loaded = readFileSync(fileURLToPath(new URL(`${name}.md`, SKILLS_DIR_URL)));
  skillCache.set(name, loaded);
  return Buffer.from(loaded);
}

export function isSkillName(value: string): value is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(value);
}

export function listSkills(): { name: SkillName; description: string }[] {
  return SKILL_NAMES.map((name) => ({ name, description: SKILL_DESCRIPTIONS[name] }));
}

/** One focused skill guide. Throws E_NOT_FOUND for unknown names. */
export function skillTemplate(name: SkillName): Buffer {
  if (!isSkillName(name)) {
    throw new DevChestraError("E_NOT_FOUND", `Unknown skill '${name}'.`);
  }
  return readSkillFile(name);
}

/** Parent menu printed by `devchestra skill` with no skill name. */
export function skillMenu(): string {
  const rows = listSkills()
    .map(({ name, description }) => `  ${name} — ${description}`)
    .join("\n");
  return [
    "DevChestra skills — run one for the task at hand, not all at once.",
    "Usage: devchestra skill <name> | devchestra skill --all",
    "",
    rows,
    "",
    "Start with `devchestra skill basics`. Validator wins over guide text.",
    "",
  ].join("\n");
}

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
