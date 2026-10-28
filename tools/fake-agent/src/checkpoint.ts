import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FakeCheckpoint } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCheckpoint(value: unknown): FakeCheckpoint {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.profile !== "fake" ||
    typeof value.sessionId !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.nextStepIndex !== "number" ||
    !Number.isSafeInteger(value.nextStepIndex) ||
    value.nextStepIndex < 0 ||
    typeof value.submitted !== "boolean"
  ) {
    throw new Error("Fake checkpoint has an unsupported shape.");
  }
  return {
    version: 1,
    profile: "fake",
    sessionId: value.sessionId,
    cwd: value.cwd,
    nextStepIndex: value.nextStepIndex,
    submitted: value.submitted,
  };
}

export async function readCheckpoint(path: string): Promise<FakeCheckpoint | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return parseCheckpoint(JSON.parse(raw) as unknown);
}

/** Write atomically so a crash cannot leave a half-written resume point. */
export async function writeCheckpoint(path: string, checkpoint: FakeCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
