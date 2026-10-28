import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RelayError } from "@relay/core";
import type { Invocation } from "./types.js";

export async function materializeInvocation(inv: Invocation): Promise<void> {
  for (const file of inv.files) {
    try {
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      if (file.symlink !== undefined) {
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
      throw new RelayError("E_WORKSPACE", `Cannot write invocation file ${file.path}`, {
        cause: error,
      });
    }
  }
}
