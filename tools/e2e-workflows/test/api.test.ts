import { beforeAll, describe, expect, it } from "vitest";
import { ensurePrereqs } from "../src/prereqs.js";
import { restartPersistenceScenario, runHttpScenario } from "../src/scenario-http.js";
import { runSecurityScenario } from "../src/scenario-security.js";

beforeAll(() => {
  ensurePrereqs({ browser: false });
});

describe("managed workflow API", () => {
  it("creates, validates, byte-stably saves, runs, conflicts and deletes real files", async () => {
    const evidence = await runHttpScenario();
    expect(evidence.nodeTypes.sort()).toEqual(["agent", "end", "shell", "start"]);
    expect(evidence.canonicalByteStable).toBe(true);
    expect(evidence.layoutOnlyDiff).toBe(true);
    expect(evidence.draftSemanticInvalidSaved).toBe(true);
    expect(evidence.validationIssues).toBeGreaterThan(0);
    expect([400, 422]).toContain(evidence.invalidRunRejected);
    expect(evidence.run202).toBe(true);
    expect(evidence.duplicateRunId).toBe(true);
    expect(evidence.duplicateConflict).toBe(409);
    expect(evidence.staleRunEtag).toBe(409);
    expect(evidence.staleDetailsEtag).toBe(true);
    expect(evidence.snapshotImmutable).toBe(true);
    expect(evidence.finalStatus).toBe("succeeded");
    expect(evidence.deletedWorkflow).toBe(204);
    expect(evidence.deleteKeptRun).toBe(true);
    expect(evidence.deleteMissingIfMatch).toBeGreaterThanOrEqual(400);
    expect(evidence.deleteMissingIfMatch).toBeLessThan(500);
    expect(evidence.unknownFieldRejected).toBe(400);
    expect(evidence.etagHeaderQuoted).toBe(true);
  }, 180_000);

  it("persists managed files across restart", async () => {
    const evidence = await restartPersistenceScenario();
    expect(evidence.sameText).toBe(true);
  }, 120_000);
});

describe("file authoring and security", () => {
  it("rejects traversal, symlink/hardlink escapes, stale writes and CSRF/host faults", async () => {
    const evidence = await runSecurityScenario();
    const byName = new Map(evidence.cases.map((item) => [item.name, item.status]));
    expect(byName.get("missing-cookie")).toBe(401);
    expect(byName.get("wrong-host")).toBe(421);
    expect(byName.get("foreign-origin")).toBe(403);
    expect(byName.get("missing-csrf")).toBe(403);
    expect(byName.get("missing-content-type")).toBe(403);
    expect(byName.get("unknown-create-field")).toBe(400);
    expect(byName.get("unsupported-template")).toBe(400);
    expect(byName.get("invalid-workflow-id")).toBe(400);
    expect(byName.get("foreign-project-write")).toBe(404);
    expect(byName.get("missing-if-match")).toBeGreaterThanOrEqual(400);
    expect(byName.get("missing-if-match")).toBeLessThan(500);
    expect(byName.get("wildcard-if-match")).toBeGreaterThanOrEqual(400);
    expect(byName.get("wildcard-if-match")).toBeLessThan(500);
    expect(byName.get("run-missing-etag")).toBe(400);
    expect(byName.get("oversize-json")).toBe(413);
    expect(byName.get("symlink-final-get")).toBeLessThan(500);
    expect(byName.get("symlink-final-put")).toBeLessThan(500);
    expect(byName.get("hardlink-get")).toBeLessThan(500);
    expect(byName.get("hardlink-put")).toBeLessThan(500);
    expect(byName.get("symlink-parent-create")).toBeLessThan(500);
    expect(byName.get("external-edit-stale-put")).toBe(409);
    expect(evidence.noRunSideEffects).toBe(true);
    expect(evidence.externalEditConflict).toBe(409);
    expect(evidence.wildcardRejected).toBeGreaterThanOrEqual(400);
    expect(evidence.deleteManagedOnly).toBe(true);
    expect(evidence.atomicDirectoryClean).toBe(true);
    expect(evidence.headersStrict).toBe(true);
  }, 180_000);
});
