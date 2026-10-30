import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DevChestraError } from "@devchestra/core";
import { parseContextEntries } from "@devchestra/schema";
import { pathSafety, realRoot } from "@devchestra/workspaces";
import { type CliOptions, UsageError } from "./args.js";
import { loadProjectContext } from "./workflow.js";

function contextFile(projectRoot: string): string {
  const resolved = pathSafety.resolveInside(projectRoot, ".devchestra/context.json");
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

/** Human authoring for the project static context pool (`.devchestra/context.json`). */
export async function executeContext(options: CliOptions): Promise<number> {
  if (options.project === undefined) {
    throw new UsageError("context requires --project <dir>.");
  }
  const projectRoot = realRoot(resolve(options.project));
  const action = options.contextAction ?? "list";
  if (action === "list") {
    const entries = await loadProjectContext(projectRoot);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ entries })}\n`);
    } else if (entries.length === 0) {
      process.stdout.write("No project context entries.\n");
    } else {
      for (const entry of entries) process.stdout.write(`${entry.key}=${entry.value}\n`);
    }
    return 0;
  }
  const key = options.contextKey;
  if (key === undefined) {
    throw new UsageError(`context ${action} requires a key.`);
  }
  let file: string;
  try {
    file = contextFile(projectRoot);
  } catch (error) {
    if (action === "delete" && error instanceof DevChestraError && error.code === "E_NOT_FOUND") {
      return 0;
    }
    if (error instanceof DevChestraError && error.code === "E_NOT_FOUND") {
      await mkdir(join(projectRoot, ".devchestra"), { recursive: true });
      file = join(projectRoot, ".devchestra", "context.json");
    } else {
      throw error;
    }
  }
  let current: unknown = [];
  try {
    current = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parsed = parseContextEntries(current);
  if (!parsed.ok) throw parsed.error;
  const entries = parsed.value.filter((entry) => entry.key !== key);
  if (action === "set") {
    if (options.contextValue === undefined) throw new UsageError("context set requires a value.");
    entries.push({ key, value: options.contextValue });
  }
  const checked = parseContextEntries(entries);
  if (!checked.ok) throw checked.error;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(checked.value, null, 2)}\n`, "utf8");
  process.stdout.write(
    action === "set" ? `Set project context '${key}'.\n` : `Deleted project context '${key}'.\n`,
  );
  return 0;
}
