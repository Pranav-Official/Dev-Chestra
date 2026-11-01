import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readWorkflowGroups, saveWorkflowGroups } from "../src/workflows/groups.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devchestra-groups-"));
  roots.push(root);
  return { id: "p", path: root, kind: "folder" as const, missing: false };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("workflow groups", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "devchestra-data-"));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("persists groups, detects stale revisions, and keeps workflow files separate", async () => {
    const project = fixture();
    const initial = readWorkflowGroups(project, dataDir);
    mkdirSync(join(project.path, ".devchestra", "workflows"), { recursive: true });
    writeFileSync(join(project.path, ".devchestra", "workflows", "review.json"), "{}");
    const document = {
      version: 1 as const,
      groups: [{ id: "grp_0123456789abcdef01234567", name: "PR Review" }],
      memberships: { review: "grp_0123456789abcdef01234567" },
    };
    const saved = await saveWorkflowGroups(project, dataDir, document, initial.etag);
    expect(readWorkflowGroups(project, dataDir)).toEqual(saved);
    await expect(
      saveWorkflowGroups(project, dataDir, document, initial.etag),
    ).rejects.toMatchObject({ code: "E_CONFLICT" });
    expect(
      JSON.parse(readFileSync(join(project.path, ".devchestra/workflow-groups.json"), "utf8")),
    ).toEqual(document);
  });
  it("rejects malformed metadata and symlinks without overwriting them", async () => {
    const project = fixture();
    const initial = readWorkflowGroups(project, dataDir);
    await saveWorkflowGroups(project, dataDir, initial.document, initial.etag);
    const path = join(project.path, ".devchestra/workflow-groups.json");
    writeFileSync(path, "{broken");
    expect(() => readWorkflowGroups(project, dataDir)).toThrow(/invalid JSON/);
    rmSync(path);
    symlinkSync(join(project.path, "target"), path);
    expect(() => readWorkflowGroups(project, dataDir)).toThrow();
  });
});
