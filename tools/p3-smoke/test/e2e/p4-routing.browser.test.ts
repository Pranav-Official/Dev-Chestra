import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { afterAll, afterEach, describe, it } from "vitest";
import {
  bootstrapPage,
  createBlankWorkflowThroughUi,
  fitView,
  launchBrowser,
  registerProjectThroughUi,
  runFromEditor,
  saveNow,
  selectNode,
  setAgentCliFake,
  waitRunSucceeded,
  waitValidation,
} from "../../src/browser-ui.js";
import { CLI, scriptPath, sleep } from "../../src/fixtures.js";
import { RelayHttp } from "../../src/http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "../../src/owned.js";
import { collectSpawnedAgents } from "../../src/store-read.js";
import { getWorkflow, waitTerminal } from "../../src/workflow-api.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  tempRoot,
} from "../support/run-workspace-fixtures.js";
import { readEventPage } from "../support/run-workspace-harness.js";

let preserveRoots = false;

afterEach((context) => {
  const state = (context as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (state !== "pass") preserveRoots = true;
});

afterAll(() => {
  if (preserveRoots) {
    process.stderr.write("p4 browser acceptance retained owned temp roots after failure\n");
    return;
  }
  cleanupTempRoots();
});

const NODE_COUNT = 6;
const EDGE_COUNT = 6;

async function waitEdges(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".react-flow__edge").length === expected,
    count,
    { timeout: 15_000 },
  );
}

async function connectExact(page: Page, source: string, target: string, fit = true): Promise<void> {
  if (fit) await fitView(page);
  const from = page.locator(source).first();
  const to = page.locator(target).first();
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  assert.ok(start !== null, `source ${source} is not visible`);
  assert.ok(end !== null, `target ${target} is not visible`);
  const fromX = start.x + start.width / 2;
  const fromY = start.y + start.height / 2;
  const toX = end.x + end.width / 2;
  const toY = end.y + end.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + (toX - fromX) * 0.25, fromY + (toY - fromY) * 0.25, {
    steps: 4,
  });
  const connectionStarted =
    (await page.locator(".react-flow__connection").count()) > 0 ||
    (await page.locator(".react-flow__connection-path").count()) > 0;
  if (!connectionStarted) {
    const attrs = async (selector: string) => {
      const locator = page.locator(selector).first();
      return {
        box: await locator.boundingBox(),
        nodeId: await locator.getAttribute("data-nodeid"),
        handleId: await locator.getAttribute("data-handleid"),
        cls: await locator.getAttribute("class"),
      };
    };
    await page.mouse.up();
    throw new Error(
      `React Flow connection did not start: source=${JSON.stringify(await attrs(source))} target=${JSON.stringify(await attrs(target))}`,
    );
  }
  await page.mouse.move(toX, toY, { steps: 18 });
  await page.mouse.up();
  await sleep(120);
}

async function addPaletteNode(page: Page, type: string): Promise<void> {
  await page.getByTestId(`palette-add-${type}`).click();
  await page.locator(".react-flow__node").last().waitFor({ state: "visible", timeout: 10_000 });
}

async function buildSixNodeWorkflow(
  http: RelayHttp,
  page: Page,
  projectId: string,
  workflowId: string,
): Promise<void> {
  for (const type of ["start", "gate", "agent", "agent", "join", "end"]) {
    await addPaletteNode(page, type);
  }
  await fitView(page);
  assert.equal(await page.locator(".react-flow__node").count(), NODE_COUNT);

  await selectNode(page, "start");
  await page.getByTestId("inspector-add-param").click();
  await page.getByTestId("inspector-param-0-name").fill("route");
  await page.getByTestId("inspector-param-0-required").check();

  await selectNode(page, "gate");
  await page.getByTestId("gate-branch-0-id").fill("a");
  await page.getByTestId("gate-branch-0-id").press("Enter");
  await page.locator('[data-testid="ed-handle-gate-out-a"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByTestId("gate-branch-0-when").fill('start.route = "a"');
  await page.getByTestId("gate-branch-0-when").blur();

  await selectNode(page, "agent");
  await setAgentCliFake(http, page, projectId, workflowId, "agent");
  await page.getByTestId("inspector-agent-prompt").fill("Branch A for {{ start.route }}.");
  await selectNode(page, "agent2");
  await setAgentCliFake(http, page, projectId, workflowId, "agent2");
  await page.getByTestId("inspector-agent-prompt").fill("Branch B for {{ start.route }}.");

  await selectNode(page, "join");
  await page.getByTestId("join-mode").selectOption("first");
  await page.getByTestId("join-input-0-name").fill("a");
  await page.getByTestId("join-input-0-name").blur();
  try {
    await page.locator('[data-testid="ed-handle-join-in-a"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });
  } catch (error) {
    const values = await page
      .getByTestId(/^join-input-\d+-name$/)
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
    const handles = await page
      .locator('[data-testid^="ed-handle-join-in-"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    const field = page.getByTestId("join-input-0-name");
    const invalid = await field.getAttribute("aria-invalid");
    const describedBy = await field.getAttribute("aria-describedby");
    const described =
      describedBy === null
        ? null
        : await page
            .locator(`[id="${describedBy.split(" ")[0]}"]`)
            .textContent()
            .catch(() => null);
    const alert = await page.locator('[role="alert"]').allTextContents();
    throw new Error(
      `join handle did not rename: inputs=${JSON.stringify(values)} handles=${JSON.stringify(handles)} invalid=${String(invalid)} described=${String(described)} alerts=${JSON.stringify(alert)}`,
      { cause: error },
    );
  }
  await page.getByTestId("join-input-add").click();
  await page.getByTestId("join-input-1-name").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("join-input-1-name").fill("b");
  await page.getByTestId("join-input-1-name").blur();
  await page.locator('[data-testid="ed-handle-join-in-b"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });

  await selectNode(page, "end");
  await page.getByTestId("inspector-end-result").fill("join");

  await connectExact(page, '[data-id="start"] .ed-handle-out', '[data-id="gate"] .ed-handle-in');
  await waitEdges(page, 1);
  await connectExact(
    page,
    '[data-testid="ed-handle-gate-out-a"]',
    '[data-id="agent"] .ed-handle-in',
  );
  await waitEdges(page, 2);
  await connectExact(
    page,
    '[data-testid="ed-handle-gate-out-otherwise"]',
    '[data-id="agent2"] .ed-handle-in',
  );
  await waitEdges(page, 3);
  await connectExact(
    page,
    '[data-id="agent"] .ed-handle-out',
    '[data-testid="ed-handle-join-in-a"]',
  );
  await waitEdges(page, 4);
  await connectExact(
    page,
    '[data-id="join"] .ed-handle-out',
    '[data-id="end"] .ed-handle-in',
    false,
  );
  try {
    await waitEdges(page, 5);
  } catch (error) {
    const alerts = await page.locator('[role="alert"]').allTextContents();
    const inspect = async (selector: string) => {
      const locator = page.locator(selector).first();
      const box = await locator.boundingBox();
      const hit =
        box === null
          ? null
          : await page.evaluate(
              ({ x, y }) => {
                const element = document.elementFromPoint(x, y);
                return element === null
                  ? null
                  : {
                      tag: element.tagName,
                      testId: element.getAttribute("data-testid"),
                      cls: element.getAttribute("class"),
                    };
              },
              { x: box.x + box.width / 2, y: box.y + box.height / 2 },
            );
      return { box, hit };
    };
    throw new Error(
      `join->end did not create an edge: alerts=${JSON.stringify(alerts)} source=${JSON.stringify(await inspect('[data-id="join"] .ed-handle-out'))} target=${JSON.stringify(await inspect('[data-id="end"] .ed-handle-in'))}`,
      { cause: error },
    );
  }
  await fitView(page);
  await page.locator(".react-flow__controls-zoomout").first().click();
  await sleep(300);
  await connectExact(
    page,
    '[data-id="agent2"] .ed-handle-out',
    '[data-testid="ed-handle-join-in-b"]',
    false,
  );
  try {
    await waitEdges(page, 6);
  } catch (error) {
    const edges = await page
      .locator(".react-flow__edge")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? node.id));
    const inputs = await page
      .getByTestId(/^join-input-\d+-name$/)
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
    const alerts = await page.locator('[role="alert"]').allTextContents();
    const inspect = async (testId: string) => {
      const locator = page.locator(`[data-testid="${testId}"]`).first();
      const box = await locator.boundingBox();
      const hit =
        box === null
          ? null
          : await page.evaluate(
              ({ x, y }) => {
                const element = document.elementFromPoint(x, y);
                return element === null
                  ? null
                  : {
                      tag: element.tagName,
                      testId: element.getAttribute("data-testid"),
                      cls: element.getAttribute("class"),
                    };
              },
              { x: box.x + box.width / 2, y: box.y + box.height / 2 },
            );
      return { box, hit };
    };
    throw new Error(
      `agent2->join.b did not create an edge: edges=${JSON.stringify(edges)} inputs=${JSON.stringify(inputs)} alerts=${JSON.stringify(alerts)} source=${JSON.stringify(await inspect("ed-handle-agent2-out"))} target=${JSON.stringify(await inspect("ed-handle-join-in-b"))}`,
      { cause: error },
    );
  }
}

async function waitStatus(page: Page, id: string, status: string): Promise<void> {
  await page.waitForFunction(
    ({ id: nodeId, status: expected }) =>
      (document.querySelector(`[data-testid="run-node-status-${nodeId}"]`)?.textContent ?? "")
        .trim()
        .toLowerCase() === expected,
    { id, status },
    { timeout: 20_000 },
  );
}

async function waitDeadEdges(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".react-flow__edge.dead").length === expected,
    count,
    { timeout: 20_000 },
  );
}

async function replayToIndex(page: Page, index: number): Promise<void> {
  const slider = page.getByTestId("replay-scrubber");
  const max = Number(await slider.getAttribute("max"));
  assert.ok(index > 0 && index < max, `replay index ${index} must be historical (max ${max})`);
  await slider.focus();
  for (let step = max; step > index; step -= 1) {
    await page.keyboard.press("ArrowLeft");
  }
}

function raiseCleanup(failure: unknown, failures: unknown[], label: string): void {
  if (failure !== undefined && failures.length > 0) {
    throw new AggregateError([failure, ...failures], `${label} cleanup`);
  }
  if (failure !== undefined) throw failure;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${label} cleanup`);
}

describe("P4 routing Chromium acceptance", () => {
  it("creates, previews, saves, reloads, undoes, runs and replays a six-node routing graph", async () => {
    const repo = makeRunWorkspaceRepo("relay-p4-browser-");
    const work = tempRoot("relay-p4-browser-work-");
    const dataDir = join(work.dir, "data");
    const profileDir = join(work.dir, "profile");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const sentinel = startSentinel();
    let server: OwnedServer | null = null;
    let context: BrowserContext | null = null;
    let failure: unknown;
    try {
      server = await startServer({
        cli: CLI,
        dataDir,
        cwd: repo.root,
        fakeScript: scriptPath("summary"),
        env: {
          HOME: repo.home,
          GIT_CONFIG_GLOBAL: join(repo.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      const http = new RelayHttp(server.baseUrl);
      await http.health();
      await http.bootstrap(server.meta.token);
      const session = await launchBrowser({
        root: work.dir,
        projectDir: repo.root,
        dataDir,
        profileDir,
      });
      context = session.context;
      const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
      const projectId = await registerProjectThroughUi(page, repo.root);
      const workflowId = await createBlankWorkflowThroughUi(page, projectId, "P4 routing browser");
      await buildSixNodeWorkflow(http, page, projectId, workflowId);

      const runsBefore = await http.api("GET", `/api/runs?project=${projectId}`);
      const runCountBefore = ((runsBefore.body as { items?: unknown[] }).items ?? []).length;
      const agentsBefore = collectSpawnedAgents(dataDir).length;
      let runPosts = 0;
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(request.url()).pathname)
        ) {
          runPosts += 1;
        }
      });

      await selectNode(page, "gate");
      await page.getByTestId("gate-tester-scope").fill('{"start":{"route":"a"}}');
      await page.getByTestId("gate-tester-run").click();
      const branch = page.getByTestId("gate-tester-branch");
      await branch.waitFor({ state: "visible", timeout: 15_000 });
      assert.match((await branch.textContent()) ?? "", /\ba\b/u);
      assert.equal(runPosts, 0, "preview must not start a run");
      assert.equal(collectSpawnedAgents(dataDir).length, agentsBefore, "preview must not spawn");

      await page.getByTestId("gate-branch-0-when").fill("start.route");
      await page.getByTestId("gate-tester-run").click();
      await page.getByTestId("gate-tester-error").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(runPosts, 0, "failed preview must not start a run");
      await page.getByTestId("gate-branch-0-when").fill('start.route = "a"');

      await page.getByRole("button", { name: "Undo" }).click();
      await sleep(120);
      await page.getByRole("button", { name: "Redo" }).click();

      await saveNow(page);
      const saved = await getWorkflow(http, projectId, workflowId);
      assert.ok(
        saved.validation.ok,
        `saved routing workflow is invalid: ${JSON.stringify(saved.validation.errors)}`,
      );
      await waitValidation(page, "Valid");
      const edges = saved.workflow.graph.edges as Array<{ from: string; to: string }>;
      assert.ok(edges.some((edge) => edge.from === "gate.a" && edge.to === "agent"));
      assert.ok(edges.some((edge) => edge.from === "gate.otherwise" && edge.to === "agent2"));
      assert.ok(edges.some((edge) => edge.from === "agent" && edge.to === "join.a"));
      assert.ok(edges.some((edge) => edge.from === "agent2" && edge.to === "join.b"));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("editor-page").waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("editor-canvas").waitFor({ state: "visible", timeout: 20_000 });
      await fitView(page);
      await waitEdges(page, EDGE_COUNT);
      await selectNode(page, "gate");
      assert.equal(await page.getByTestId("gate-branch-0-id").inputValue(), "a");
      assert.equal(await page.getByTestId("gate-branch-0-when").inputValue(), 'start.route = "a"');
      await selectNode(page, "join");
      assert.equal(await page.getByTestId("join-mode").inputValue(), "first");
      assert.equal(await page.getByTestId("join-input-0-name").inputValue(), "a");
      assert.equal(await page.getByTestId("join-input-1-name").inputValue(), "b");

      const run = await runFromEditor(page, { route: "a" });
      assert.equal(run.responseStatus, 202);
      await waitRunSucceeded(page);
      const terminal = await waitTerminal(http, run.runId);
      assert.equal(terminal.status, "succeeded");
      assert.equal(runPosts, 1);
      await waitStatus(page, "gate", "succeeded");
      await waitStatus(page, "agent", "succeeded");
      await waitStatus(page, "agent2", "skipped");
      await waitDeadEdges(page, 2);
      assert.match(
        (await page.getByTestId("run-gate-branch-gate").textContent()) ?? "",
        /branch a/u,
      );
      assert.match(
        (await page.getByTestId("run-join-active-join").textContent()) ?? "",
        /active a/u,
      );
      assert.match(
        (await page.getByTestId("run-join-skipped-join").textContent()) ?? "",
        /skipped b/u,
      );
      assert.equal(await page.locator(".react-flow__edge.dead").count(), 2);
      assert.equal(await page.getByTestId("run-node-agent2").count(), 1);

      const pageEvents = await readEventPage(http, run.runId);
      const joinIndex = pageEvents.events.findIndex((event) => event.type === "join.resolved");
      assert.ok(joinIndex > 0, "join.resolved must be present");
      await page.getByTestId("replay-bar").waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        (index) =>
          Number(
            document.querySelector('[data-testid="replay-scrubber"]')?.getAttribute("max") ?? 0,
          ) > index,
        joinIndex,
        { timeout: 20_000 },
      );
      await replayToIndex(page, joinIndex);
      assert.match(
        (await page.locator(".replay-meta .v").textContent()) ?? "",
        /^Event #/u,
        "viewer must be at a historical cursor",
      );
      assert.match(
        (await page.getByTestId("run-gate-branch-gate").textContent()) ?? "",
        /branch a/u,
      );
      assert.match(
        (await page.getByTestId("run-join-active-join").textContent()) ?? "",
        /active a/u,
      );
      assert.equal(await page.locator(".react-flow__edge.dead").count(), 2);
      await page.getByTestId("back-to-live").click();
      await page.getByTestId("run-status").waitFor({ state: "visible" });

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
      await waitStatus(page, "agent2", "skipped");
      await waitDeadEdges(page, 2);
      assert.equal(
        await page
          .getByTestId("run-node-status-gate")
          .textContent()
          .then((t) => t?.toLowerCase()),
        "succeeded",
      );

      assert.equal(
        ((await http.api("GET", `/api/runs?project=${projectId}`)).body as { items?: unknown[] })
          .items?.length,
        runCountBefore + 1,
      );
    } catch (error) {
      failure = error;
    }
    const failures: unknown[] = [];
    if (context !== null) {
      try {
        await context.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (server === null) {
      if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
      else failures.push(new Error("unrelated sentinel died during browser cleanup"));
    } else {
      let agents: ReturnType<typeof collectSpawnedAgents> = [];
      try {
        agents = collectSpawnedAgents(dataDir);
      } catch (error) {
        failures.push(error);
      }
      try {
        await shutdownOwned({
          server,
          agents,
          sentinel,
          keep: failures.length > 0,
          dataDir,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    raiseCleanup(failure, failures, "browser");
  }, 420_000);
});
