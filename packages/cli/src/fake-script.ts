import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UsageError } from "./args.js";

/**
 * Explicit caller-provided fake fixture. It is never read from workflow
 * cliOptions and never auto-selected from a project file.
 */
export async function loadFakeScript(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) {
    const fromEnv = process.env.FAKE_AGENT_SCRIPT;
    return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
  }
  const absolute = resolve(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new UsageError(
      `--fake-script could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--fake-script must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError("--fake-script must contain a JSON array of fake-agent steps.");
  }
  return JSON.stringify(parsed);
}

export function requireFakeScript(script: string | undefined): string {
  if (script === undefined) {
    throw new UsageError(
      "A workflow with fake agent nodes requires --fake-script <file> (or trusted FAKE_AGENT_SCRIPT). The fake default submits nothing.",
    );
  }
  return script;
}
