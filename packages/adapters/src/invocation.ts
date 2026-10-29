import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DevChestraError } from "@devchestra/core";
import type { Invocation } from "./types.js";
import { protectWindowsDirectory } from "./windows.js";

const staged = new WeakMap<Invocation, { path: string; target: string; original: Buffer }[]>();

export async function materializeInvocation(inv: Invocation): Promise<void> {
  for (const file of inv.files) {
    try {
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      protectWindowsDirectory(dirname(file.path));
      if (file.symlink !== undefined) {
        if (process.platform === "win32") {
          const original = await readFile(file.symlink);
          await writeFile(file.path, original, { mode: 0o600 });
          const entries = staged.get(inv) ?? [];
          entries.push({ path: file.path, target: file.symlink, original });
          staged.set(inv, entries);
          continue;
        }
        // Refresh-safe: replace any previous materialization, then link the
        // canonical store so reads see live credentials and writes persist.
        try {
          await unlink(file.path);
        } catch {
          // Absent: nothing to replace.
        }
        await symlink(file.symlink, file.path);
        continue;
      }
      if (file.content === undefined) {
        throw new Error(`invocation file ${file.path} needs content or a symlink target`);
      }
      await writeFile(file.path, file.content, { encoding: "utf8", mode: file.mode ?? 0o600 });
      await chmod(file.path, file.mode ?? 0o600);
    } catch (error) {
      throw new DevChestraError("E_WORKSPACE", `Cannot write invocation file ${file.path}`, {
        cause: error,
      });
    }
  }
}

/** Windows needs no Developer Mode: reconcile isolated Pi files under its credential lock.
 * Never overwrite a canonical file changed by another process during this invocation.
 */
export async function finalizeInvocation(inv: Invocation): Promise<void> {
  for (const entry of staged.get(inv) ?? []) {
    const updated = await readFile(entry.path);
    if (updated.equals(entry.original)) continue;
    const current = await readFile(entry.target);
    if (current.equals(updated)) continue;
    if (!current.equals(entry.original))
      throw new DevChestraError(
        "E_CONFLICT",
        "Canonical Pi credentials or settings changed during execution; isolated updates were retained",
      );
    const temporary = `${entry.target}.devchestra-${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
      await rename(temporary, entry.target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  staged.delete(inv);
}
