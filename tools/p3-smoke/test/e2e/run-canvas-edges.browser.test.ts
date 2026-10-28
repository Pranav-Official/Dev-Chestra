import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { describe, it } from "vitest";
import {
  bootstrapPage,
  launchBrowser,
  openEditor,
  registerProjectThroughUi,
} from "../../src/browser-ui.js";
import { CLI } from "../../src/fixtures.js";
import { DevChestraHttp } from "../../src/http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "../../src/owned.js";
import { collectSpawnedAgents } from "../../src/store-read.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  tempRoot,
} from "../support/run-workspace-fixtures.js";

const STEPS = 4;

function chainWorkflow(): unknown {
  const nodes: unknown[] = [
    { id: "start", type: "start", name: "Start", params: [], ui: { x: 60, y: 300 } },
  ];
  const edges: unknown[] = [];
  let previous = "start";
  for (let index = 1; index <= STEPS; index += 1) {
    const id = `s${index}`;
    nodes.push({
      id,
      type: "shell",
      name: `Step ${index}`,
      command: "sleep 1.5; echo ok",
      ui: { x: 60 + index * 260, y: index % 2 === 1 ? 300 : 160 },
    });
    edges.push({ id: `e${index}`, from: previous, to: id });
    previous = id;
  }
  nodes.push({
    id: "end",
    type: "end",
    name: "End",
    status: "success",
    result: "{}",
    ui: { x: 1400, y: 300 },
  });
  edges.push({ id: `e${STEPS + 1}`, from: previous, to: "end" });
  return { schemaVersion: 1, id: "edges", name: "Edges", graph: { nodes, edges } };
}

async function startRunFromEditor(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const review = page.getByRole("button", { name: "Review and run" });
  if ((await review.count()) > 0) await review.click();
  await page.getByRole("button", { name: "Start run" }).click();
  await page.waitForURL(/\/r\//u, { timeout: 20_000 });
}

describe("run canvas keeps its edges", () => {
  // Regression: starting a run from the editor could leave the run canvas with
  // every node and no edges until the page was remounted. Under CPU pressure the
  // unfixed canvas lost all edges for the whole run in about 11 of 12 attempts.
  it("draws every edge, and keeps drawing them, while a run started from the editor streams", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-edges-browser-");
    const work = tempRoot("devchestra-edges-browser-work-");
    const dataDir = join(work.dir, "data");
    const profileDir = join(work.dir, "profile");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(join(repo.root, ".devchestra", "workflows"), { recursive: true });
    writeFileSync(
      join(repo.root, ".devchestra", "workflows", "edges.json"),
      JSON.stringify(chainWorkflow()),
    );

    const sentinel = startSentinel();
    let server: OwnedServer | null = null;
    let context: BrowserContext | null = null;
    let testFailure: unknown;
    let failed = false;
    try {
      server = await startServer({ cli: CLI, dataDir, cwd: repo.root });
      const http = new DevChestraHttp(server.baseUrl);
      await http.health();
      const session = await launchBrowser({
        root: work.dir,
        projectDir: repo.root,
        dataDir,
        profileDir,
      });
      context = session.context;
      const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
      const projectId = await registerProjectThroughUi(page, repo.root);

      // Slow the page down so the race window is wide, as on a busy laptop.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await openEditor(page, projectId, "edges");
        await page.waitForFunction(
          (count) => document.querySelectorAll(".react-flow__node").length === count,
          STEPS + 2,
          { timeout: 20_000 },
        );
        await startRunFromEditor(page);

        const expected = STEPS + 1;
        let longestGap = 0;
        let gap = 0;
        let reached = false;
        const stopAt = Date.now() + 7_000;
        while (Date.now() < stopAt) {
          const nodes = await page.locator('[data-testid="run-canvas"] .react-flow__node').count();
          const edges = await page.locator('[data-testid="run-canvas"] .react-flow__edge').count();
          if (nodes === STEPS + 2) {
            if (edges === expected) {
              reached = true;
              gap = 0;
            } else {
              gap += 1;
              longestGap = Math.max(longestGap, gap);
            }
          }
          await page.waitForTimeout(100);
        }
        const finalEdges = await page
          .locator('[data-testid="run-canvas"] .react-flow__edge')
          .count();
        assert.ok(reached, `attempt ${attempt}: the run canvas never drew all ${expected} edges`);
        assert.equal(finalEdges, expected, `attempt ${attempt}: edges were missing at the end`);
        // A brief first-measure gap is normal; losing edges for seconds is the bug.
        assert.ok(
          longestGap <= 10,
          `attempt ${attempt}: edges were missing for ${longestGap * 100}ms in a row`,
        );
      }
    } catch (error) {
      failed = true;
      testFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    if (context !== null) {
      try {
        await context.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (server !== null) {
      let agents: ReturnType<typeof collectSpawnedAgents> = [];
      let keep = false;
      try {
        agents = collectSpawnedAgents(dataDir);
      } catch (error) {
        cleanupFailures.push(error);
        keep = true;
      }
      try {
        await shutdownOwned({ server, agents, sentinel, keep, dataDir });
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else {
      sentinel.kill("SIGKILL");
    }
    try {
      cleanupTempRoots();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (failed) throw testFailure;
    if (cleanupFailures.length > 0) throw cleanupFailures[0];
  }, 180_000);
});
