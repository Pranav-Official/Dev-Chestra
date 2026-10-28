import { beforeAll, describe, expect, it } from "vitest";
import { ensurePrereqs } from "../src/prereqs.js";
import { runLiveScenario } from "../src/scenario-live.js";
import { runNegativeScenario } from "../src/scenario-negative.js";
import { runPagingScenario } from "../src/scenario-paging.js";
import { runShutdownScenario } from "../src/scenario-shutdown.js";

beforeAll(() => {
  ensurePrereqs({ browser: false });
});

describe("P2 live API and SSE", () => {
  it("starts before end, reconnects losslessly and matches the real projection", async () => {
    const evidence = await runLiveScenario();
    expect(evidence.startBeforeEnd).toBe(true);
    expect(evidence.idempotentDuplicate).toBe(true);
    expect(evidence.idempotencyConflict).toBe(true);
    expect(evidence.finalStatus).toBe("succeeded");
    expect(evidence.totalEvents).toBeGreaterThan(20);
    expect(evidence.firstConnectionEvents).toBeGreaterThan(0);
    expect(evidence.reconnectedEvents).toBeGreaterThan(0);
    expect(evidence.finalEventId).toBeGreaterThan(evidence.snapshotWatermark);
  }, 120_000);
});

describe("P2 paging and backlog", () => {
  it("pages a >500 event backlog without loss or duplication", async () => {
    const evidence = await runPagingScenario();
    expect(evidence.totalEvents).toBeGreaterThan(500);
    expect(evidence.pages).toBeGreaterThan(1);
    expect(evidence.maxPageItems).toBeLessThanOrEqual(100);
    expect(evidence.filteredCompleted).toBe(1);
    expect(evidence.filteredPath).toBeGreaterThan(0);
    expect([400, 409]).toContain(evidence.futureCursorRejected);
    expect(evidence.upToRespected).toBe(true);
    expect(evidence.projectPagingOk).toBe(true);
  }, 120_000);
});

describe("P2 shutdown", () => {
  it("closes an open SSE and keep-alive socket on SIGTERM without orphaning agents", async () => {
    const evidence = await runShutdownScenario();
    expect(evidence.exitCode).toBe(0);
    expect(evidence.exitMs).toBeLessThan(8_000);
    expect(evidence.portClosed).toBe(true);
    expect(evidence.keepAliveSocketsClosed).toBe(true);
    expect(evidence.agentsDead).toBe(true);
    expect(evidence.sentinelAlive).toBe(true);
  }, 120_000);
});

describe("P2 negative API and security", () => {
  it("rejects missing auth, wrong host/origin/CSRF, traversal and oversize bodies", async () => {
    const evidence = await runNegativeScenario();
    const byName = new Map(evidence.cases.map((item) => [item.name, item.status]));
    expect(byName.get("missing-cookie")).toBe(401);
    expect(byName.get("wrong-host")).toBe(421);
    expect(byName.get("foreign-origin")).toBe(403);
    expect(byName.get("missing-csrf")).toBe(403);
    expect(byName.get("bearer-on-api")).toBe(401);
    expect(byName.get("cookie-on-internal")).toBeGreaterThanOrEqual(400);
    expect(byName.get("unknown-api")).toBe(404);
    expect(byName.get("project-inside-data")).toBe(403);
    expect(byName.get("project-ancestor-data")).toBe(403);
    expect(byName.get("duplicate-project-idempotent")).toBe(200);
    expect(byName.get("strict-start-body")).toBe(400);
    expect(byName.get("symlink-workflow")).toBeLessThan(500);
    expect(byName.get("execution-path-traversal")).toBeLessThan(500);
    expect(byName.get("oversize-body")).toBe(413);
    expect(byName.get("foreign-origin-sse")).toBe(403);
    expect(evidence.crossNamespaceCookieRejected).toBe(true);
    expect(evidence.crossNamespaceTokenRejected).toBe(true);
    expect(evidence.crossNamespaceRunRejected).toBe(true);
  }, 120_000);
});
