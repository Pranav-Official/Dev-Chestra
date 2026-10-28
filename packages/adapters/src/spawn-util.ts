import type { spawn } from "node:child_process";
import { DevChestraError } from "@devchestra/core";
import type { CommandHooks, RunHooks } from "./types.js";

export function redacted(hook: RunHooks | CommandHooks, text: string): string {
  return hook.redact === undefined ? text : hook.redact(text);
}

export function spawnFailure(error: unknown): DevChestraError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new DevChestraError("E_CLI_MISSING", "CLI executable was not found", { cause: error });
  }
  return new DevChestraError("E_INTERNAL", "Failed to spawn child process", { cause: error });
}

export function waitSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

export function writeStdin(child: ReturnType<typeof spawn>, input: string | undefined): void {
  child.stdin?.on("error", () => undefined);
  if (input !== undefined) child.stdin?.write(input);
  child.stdin?.end();
}

export function boundTail(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  return text.slice(-max);
}
