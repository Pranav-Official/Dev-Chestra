import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTranscript } from "../src/transcript.js";

const tempDirs: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-engine-transcript-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("transcript sink", () => {
  it("writes owner-only JSONL under the canonical data directory and closes once", () => {
    const dataDir = temp();
    const writer = openTranscript({
      dataDir,
      projectId: "p1",
      runId: "r1",
      path: "research" as never,
      attempt: 1,
      generation: 2,
      secrets: ["super-secret-token"],
    });
    writer.write({
      ts: "2026-01-01T00:00:00.000Z",
      kind: "text",
      text: "assistant: super-secret-token and sk-abcdefgh12345678",
    });
    expect(writer.bytes()).toBeGreaterThan(0);
    writer.close();
    writer.close();
    const text = readFileSync(writer.file, "utf8");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("sk-abcdefgh12345678");
  });

  it("rejects a symlinked transcript directory outside the data root", () => {
    const dataDir = temp();
    const outside = temp();
    writeFileSync(join(outside, "keep.txt"), "keep");
    mkdirSync(join(outside, "nested"), { recursive: true });
    symlinkSync(outside, join(dataDir, "projects"));
    expect(() =>
      openTranscript({
        dataDir,
        projectId: "p1",
        runId: "r1",
        path: "research" as never,
        attempt: 1,
        generation: 2,
        secrets: [],
      }),
    ).toThrow();
  });
});
