import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DevChestraError } from "../src/errors.js";
import {
  ensureProjectSkill,
  PROJECT_SKILL_RELATIVE_FILE,
  projectSkillTemplate,
} from "../src/index.js";
import { publishNewFile } from "../src/workflows/io.js";

const execFileAsync = promisify(execFile);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function sandbox(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "devchestra-skill-"));
  const root = join(base, "project");
  mkdirSync(root);
  cleanup.push(() => {
    // Restore permissions the IO-error tests removed so cleanup always succeeds.
    for (const dir of [join(root, ".devchestra"), root]) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // already gone
      }
    }
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root };
}

const skillPath = (root: string): string => join(root, ".devchestra", "skill.md");
const template = projectSkillTemplate();

/** tmpdir() may itself sit behind a symlink (macOS); the helper reports real paths. */
function realPath(path: string): string {
  return realpathSync.native(path);
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DevChestraError ? error.code : `non-devchestra:${String(error)}`;
  }
  return undefined;
}

describe("ensureProjectSkill", () => {
  it("creates .devchestra/skill.md from the bundled guide in a fresh project", () => {
    const { root } = sandbox();
    const result = ensureProjectSkill(root);
    expect(result).toEqual({
      path: join(realPath(root), ".devchestra", "skill.md"),
      relativeFile: PROJECT_SKILL_RELATIVE_FILE,
      created: true,
    });
    expect(readFileSync(skillPath(root)).equals(template)).toBe(true);
    const stat = lstatSync(skillPath(root));
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(readdirSync(join(root, ".devchestra"))).toEqual(["skill.md"]);
  });

  it("uses the lowercase file name exactly", () => {
    const { root } = sandbox();
    ensureProjectSkill(root);
    expect(readdirSync(join(root, ".devchestra"))).toEqual(["skill.md"]);
    expect(PROJECT_SKILL_RELATIVE_FILE).toBe(".devchestra/skill.md");
  });

  it("is idempotent: a repeat call neither rewrites nor replaces the file", () => {
    const { root } = sandbox();
    ensureProjectSkill(root);
    const before = statSync(skillPath(root));
    const again = ensureProjectSkill(root);
    const after = statSync(skillPath(root));
    expect(again.created).toBe(false);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(skillPath(root)).equals(template)).toBe(true);
  });

  it("preserves a user-edited file byte for byte", () => {
    const { root } = sandbox();
    ensureProjectSkill(root);
    const edited = Buffer.from("# My notes\r\né\u0000 trailing  ", "utf8");
    writeFileSync(skillPath(root), edited);
    expect(ensureProjectSkill(root).created).toBe(false);
    expect(readFileSync(skillPath(root)).equals(edited)).toBe(true);
  });

  it("preserves an empty file instead of treating it as missing", () => {
    const { root } = sandbox();
    mkdirSync(join(root, ".devchestra"));
    writeFileSync(skillPath(root), "");
    expect(ensureProjectSkill(root).created).toBe(false);
    expect(readFileSync(skillPath(root)).byteLength).toBe(0);
  });

  it("backfills a project that already has workflows, without touching them", () => {
    const { root } = sandbox();
    const workflows = join(root, ".devchestra", "workflows");
    mkdirSync(workflows, { recursive: true });
    const workflow = Buffer.from('{"keep":"me"}\n');
    writeFileSync(join(workflows, "existing.json"), workflow);
    const stat = statSync(join(workflows, "existing.json"));
    expect(ensureProjectSkill(root).created).toBe(true);
    expect(readFileSync(join(workflows, "existing.json")).equals(workflow)).toBe(true);
    expect(statSync(join(workflows, "existing.json")).mtimeMs).toBe(stat.mtimeMs);
    expect(readdirSync(workflows)).toEqual(["existing.json"]);
  });

  it("accepts an existing .devchestra directory with unrelated content", () => {
    const { root } = sandbox();
    mkdirSync(join(root, ".devchestra"));
    writeFileSync(join(root, ".devchestra", "notes.txt"), "x");
    expect(ensureProjectSkill(root).created).toBe(true);
    expect(readdirSync(join(root, ".devchestra")).sort()).toEqual(["notes.txt", "skill.md"]);
  });

  it("never creates a missing project root", () => {
    const { base } = sandbox();
    const missing = join(base, "nope", "deeper");
    expect(code(() => ensureProjectSkill(missing))).toBe("E_NOT_FOUND");
    expect(existsSync(join(base, "nope"))).toBe(false);
  });

  it("rejects a relative path and a root that is a file", () => {
    const { base } = sandbox();
    expect(code(() => ensureProjectSkill("relative/dir"))).toBe("E_VALIDATION");
    const file = join(base, "file");
    writeFileSync(file, "x");
    expect(code(() => ensureProjectSkill(file))).toBe("E_VALIDATION");
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  it("follows a symlinked project root to its real directory", () => {
    const { base, root } = sandbox();
    const link = join(base, "link");
    symlinkSync(root, link);
    expect(ensureProjectSkill(link).created).toBe(true);
    expect(readFileSync(skillPath(root)).equals(template)).toBe(true);
  });

  describe("conflicts", () => {
    it("rejects .devchestra when it is a regular file and leaves it alone", () => {
      const { root } = sandbox();
      writeFileSync(join(root, ".devchestra"), "not a directory");
      expect(code(() => ensureProjectSkill(root))).toBe("E_FORBIDDEN_PATH");
      expect(readFileSync(join(root, ".devchestra"), "utf8")).toBe("not a directory");
    });

    it("rejects .devchestra when it is a symlink to a directory and writes nothing through it", () => {
      const { base, root } = sandbox();
      const elsewhere = join(base, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(root, ".devchestra"));
      expect(code(() => ensureProjectSkill(root))).toBe("E_FORBIDDEN_PATH");
      expect(readdirSync(elsewhere)).toEqual([]);
    });

    it("rejects a dangling .devchestra symlink and does not create its target", () => {
      const { base, root } = sandbox();
      const target = join(base, "gone");
      symlinkSync(target, join(root, ".devchestra"));
      expect(code(() => ensureProjectSkill(root))).toBe("E_FORBIDDEN_PATH");
      expect(existsSync(target)).toBe(false);
    });

    it("rejects skill.md as a symlink to a file and does not modify the target", () => {
      const { base, root } = sandbox();
      const target = join(base, "real.md");
      writeFileSync(target, "target");
      mkdirSync(join(root, ".devchestra"));
      symlinkSync(target, skillPath(root));
      expect(code(() => ensureProjectSkill(root))).toBe("E_FORBIDDEN_PATH");
      expect(readFileSync(target, "utf8")).toBe("target");
      expect(lstatSync(skillPath(root)).isSymbolicLink()).toBe(true);
    });

    it("rejects a dangling skill.md symlink and never creates its target", () => {
      const { base, root } = sandbox();
      const target = join(base, "never-created.md");
      mkdirSync(join(root, ".devchestra"));
      symlinkSync(target, skillPath(root));
      expect(code(() => ensureProjectSkill(root))).toBe("E_FORBIDDEN_PATH");
      expect(existsSync(target)).toBe(false);
      expect(lstatSync(skillPath(root)).isSymbolicLink()).toBe(true);
    });

    it("rejects skill.md when it is a directory", () => {
      const { root } = sandbox();
      mkdirSync(skillPath(root), { recursive: true });
      expect(code(() => ensureProjectSkill(root))).toBe("E_FORBIDDEN_PATH");
      expect(statSync(skillPath(root)).isDirectory()).toBe(true);
    });

    it("leaves no temp files behind after a rejection", () => {
      const { base, root } = sandbox();
      mkdirSync(join(root, ".devchestra"));
      symlinkSync(join(base, "x"), skillPath(root));
      code(() => ensureProjectSkill(root));
      expect(readdirSync(join(root, ".devchestra"))).toEqual(["skill.md"]);
    });
  });

  describe("IO errors propagate", () => {
    const unprivileged = typeof process.getuid === "function" && process.getuid() !== 0;

    it.skipIf(!unprivileged)("surfaces EACCES when .devchestra cannot be created", () => {
      const { root } = sandbox();
      chmodSync(root, 0o500);
      let failure: unknown;
      try {
        ensureProjectSkill(root);
      } catch (error) {
        failure = error;
      }
      expect((failure as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
      expect(existsSync(join(root, ".devchestra"))).toBe(false);
    });

    it.skipIf(!unprivileged)("surfaces EACCES when .devchestra is not writable", () => {
      const { root } = sandbox();
      mkdirSync(join(root, ".devchestra"));
      chmodSync(join(root, ".devchestra"), 0o500);
      let failure: unknown;
      try {
        ensureProjectSkill(root);
      } catch (error) {
        failure = error;
      }
      expect((failure as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
      expect(readdirSync(join(root, ".devchestra"))).toEqual([]);
    });
  });

  it("returns a private copy of the template so callers cannot corrupt it", () => {
    const first = projectSkillTemplate();
    first.fill(0);
    expect(projectSkillTemplate().equals(template)).toBe(true);
    expect(template.toString("utf8")).toContain("# DevChestra workflow authoring guide");
  });
});

describe("publishNewFile", () => {
  it("reports an existing name without touching it, including a dangling symlink", () => {
    const { base, root } = sandbox();
    const dir = join(root, ".devchestra");
    mkdirSync(dir);
    const realDir = realPath(dir);
    writeFileSync(join(dir, "taken.md"), "mine");
    expect(publishNewFile(realDir, realPath(root), "taken.md", "taken", Buffer.from("new"))).toBe(
      false,
    );
    expect(readFileSync(join(dir, "taken.md"), "utf8")).toBe("mine");

    const target = join(base, "dangling-target");
    symlinkSync(target, join(dir, "link.md"));
    expect(publishNewFile(realDir, realPath(root), "link.md", "link", Buffer.from("new"))).toBe(
      false,
    );
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["link.md", "taken.md"]);
  });
});

describe("concurrent initialization", () => {
  it("publishes exactly once across racing processes", async () => {
    const { root } = sandbox();
    const dist = new URL("../dist/index.js", import.meta.url);
    expect(existsSync(fileURLToPath(dist)), "run `pnpm build` first").toBe(true);
    const script = `
      const { ensureProjectSkill } = await import(${JSON.stringify(dist.href)});
      const result = ensureProjectSkill(${JSON.stringify(root)});
      process.stdout.write(JSON.stringify({ created: result.created }));
    `;
    const runs = await Promise.all(
      Array.from({ length: 12 }, () =>
        execFileAsync(process.execPath, ["--input-type=module", "-e", script]),
      ),
    );
    const created = runs.map((run) => (JSON.parse(run.stdout) as { created: boolean }).created);
    expect(created.filter(Boolean)).toHaveLength(1);
    expect(readFileSync(skillPath(root)).equals(template)).toBe(true);
    expect(readdirSync(join(root, ".devchestra"))).toEqual(["skill.md"]);
    expect(lstatSync(skillPath(root)).nlink).toBe(1);
  }, 60_000);
});
