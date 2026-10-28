import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevChestraError, Result } from "@devchestra/core";

const cleanups: (() => void)[] = [];

export function tempDir(label = "devchestra-ws-"): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function cleanup(): void {
  while (cleanups.length > 0) cleanups.pop()?.();
}

export function unwrap<T>(result: Result<T, DevChestraError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export function expectError(result: Result<unknown, DevChestraError>): DevChestraError {
  if (result.ok) throw new Error("expected an error result");
  return result.error;
}
