import assert from "node:assert/strict";
import type { BrowserContext, Page } from "@playwright/test";
import {
  createBlankWorkflowThroughUi,
  openEditor,
  saveNow,
  selectNode,
  setAgentCliFake,
  waitSaved,
} from "./browser-ui.js";
import { sleep } from "./fixtures.js";
import type { DevChestraHttp } from "./http.js";
import {
  getRun,
  getWorkflow,
  quoteEtag,
  saveWorkflow,
  type WorkflowDocument,
} from "./workflow-api.js";

export interface ConflictEvidence {
  workflowId: string;
  twoPageConflict: boolean;
  reloadDiscardedLocal: boolean;
  overwriteUsedFreshEtag: boolean;
  externalEditConflict: boolean;
  inFlightKeptLatest: boolean;
  invalidBufferBlockedRun: boolean;
  runUsedFreshSave: boolean;
  runId: string;
  doubleClickOneRun: boolean;
  duplicateResponses: number;
}

async function newEditorPage(
  context: BrowserContext,
  seedUrl: string,
  projectId: string,
  workflowId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(new URL("/", seedUrl).toString(), { waitUntil: "domcontentloaded" });
  await openEditor(page, projectId, workflowId);
  return page;
}

async function promptOf(page: Page): Promise<string> {
  await selectNode(page, "agent");
  return page.getByTestId("inspector-agent-prompt").inputValue();
}

async function waitConflict(page: Page): Promise<void> {
  await page.getByTestId("conflict-banner").waitFor({ state: "visible", timeout: 20_000 });
}

async function runCount(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
): Promise<number> {
  const result = await http.api(
    "GET",
    `/api/runs?project=${encodeURIComponent(projectId)}&workflow=${encodeURIComponent(workflowId)}&limit=100`,
  );
  assert.equal(result.status, 200);
  return ((result.body as { items?: unknown[] }).items ?? []).length;
}

async function saveConflictThenOverwrite(
  http: DevChestraHttp,
  pid: string,
  wid: string,
  page: Page,
): Promise<boolean> {
  const latest = await getWorkflow(http, pid, wid);
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname ===
        `/api/projects/${encodeURIComponent(pid)}/workflows/${encodeURIComponent(wid)}`,
    { timeout: 20_000 },
  );
  await page
    .getByTestId("conflict-banner")
    .getByRole("button", { name: /^Overwrite file$/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Overwrite file" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /^Overwrite file$/ }).click();
  const request = await requestPromise;
  const ifMatch = request.headers()["if-match"];
  assert.equal(ifMatch, quoteEtag(latest.etag), "overwrite must fetch and use the current ETag");
  assert.notEqual(ifMatch, "*", "overwrite must never use a wildcard");
  await waitSaved(page);
  assert.equal(await page.getByTestId("conflict-banner").count(), 0, "conflict banner must clear");
  return true;
}

export async function runBrowserConflictFlow(
  context: BrowserContext,
  seed: Page,
  http: DevChestraHttp,
  projectId: string,
): Promise<ConflictEvidence> {
  const workflowId = await createBlankWorkflowThroughUi(
    seed,
    projectId,
    "Browser conflict workflow",
    "browser-conflicts",
    "linear",
  );
  await setAgentCliFake(http, seed, projectId, workflowId, "agent");
  const seedUrl = seed.url();
  const pageA = await newEditorPage(context, seedUrl, projectId, workflowId);
  const pageB = await newEditorPage(context, seedUrl, projectId, workflowId);
  await selectNode(pageA, "agent");
  await selectNode(pageB, "agent");

  await pageA.getByTestId("inspector-agent-prompt").fill("First editor wins");
  await saveNow(pageA);
  const first = await getWorkflow(http, projectId, workflowId);

  await pageB.getByTestId("inspector-agent-prompt").fill("Second editor must conflict");
  await pageB.getByRole("button", { name: /^Save$/ }).click();
  await waitConflict(pageB);
  const afterSecond = await getWorkflow(http, projectId, workflowId);
  assert.equal(afterSecond.text, first.text, "the second stale save must not overwrite the first");
  const twoPageConflict = true;

  await pageB
    .getByTestId("conflict-banner")
    .getByRole("button", { name: /reload from server/i })
    .click();
  const reloadDialog = pageB.getByRole("dialog", { name: "Reload from server" });
  await reloadDialog.waitFor({ state: "visible" });
  await reloadDialog.getByRole("button", { name: /reload and discard/i }).click();
  await pageB.getByTestId("conflict-banner").waitFor({ state: "hidden", timeout: 20_000 });
  assert.equal(
    await promptOf(pageB),
    "First editor wins",
    "reload must discard the local edit after confirm",
  );
  const reloadDiscardedLocal = true;

  await pageA.getByTestId("inspector-agent-prompt").fill("Newer A revision");
  await saveNow(pageA);
  await pageB.getByTestId("inspector-agent-prompt").fill("Overwrite local revision");
  await pageB.getByRole("button", { name: /^Save$/ }).click();
  await waitConflict(pageB);
  const overwriteUsedFreshEtag = await saveConflictThenOverwrite(
    http,
    projectId,
    workflowId,
    pageB,
  );

  const beforeExternal = await getWorkflow(http, projectId, workflowId);
  const external = structuredClone(beforeExternal.workflow);
  const externalAgent = external.graph.nodes.find((node) => node.type === "agent");
  assert.ok(externalAgent !== undefined);
  externalAgent.prompt = "External disk edit";
  const externalDoc = await saveWorkflow(
    http,
    projectId,
    workflowId,
    external,
    beforeExternal.etag,
  );
  assert.notEqual(externalDoc.etag, beforeExternal.etag);
  await pageB.getByTestId("inspector-agent-prompt").fill("Local stale after external edit");
  await pageB.getByRole("button", { name: /^Save$/ }).click();
  await waitConflict(pageB);
  const externalEditConflict = true;
  await pageB.close();

  const pageC = await newEditorPage(context, seedUrl, projectId, workflowId);
  await pageC.route("**/api/projects/*/workflows/*", async (route) => {
    if (route.request().method() === "PUT") await sleep(600);
    await route.continue();
  });
  await selectNode(pageC, "agent");
  const firstPut = pageC.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname ===
        `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
    { timeout: 20_000 },
  );
  await pageC.getByTestId("inspector-agent-prompt").fill("In-flight first revision");
  await pageC.getByRole("button", { name: /^Save$/ }).click();
  await firstPut;
  await pageC.getByTestId("inspector-agent-prompt").fill("In-flight latest revision");
  await waitSaved(pageC, 30_000);
  const afterInFlight = await getWorkflow(http, projectId, workflowId);
  assert.ok(
    afterInFlight.text.includes("In-flight latest revision"),
    "an edit made while a save is in flight must not be dropped",
  );
  const inFlightKeptLatest = true;

  const beforeInvalidRun = await runCount(http, projectId, workflowId);
  await selectNode(pageC, "agent");
  await pageC.getByTestId("inspector-node-name").fill("");
  await pageC.getByTestId("buffer-invalid").waitFor({ state: "visible", timeout: 10_000 });
  const runButton = pageC.getByRole("button", { name: /^Run$/ });
  assert.equal(await runButton.isDisabled(), true, "invalid form buffer must disable Run");
  await sleep(300);
  assert.equal(await runCount(http, projectId, workflowId), beforeInvalidRun);
  const invalidBufferBlockedRun = true;
  await pageC.getByTestId("inspector-node-name").fill("Agent");
  await pageC.getByTestId("buffer-invalid").waitFor({ state: "hidden", timeout: 10_000 });

  await pageC.getByTestId("inspector-agent-prompt").fill("Run latest prompt");
  const responses: Array<{ runId: string; duplicate: boolean }> = [];
  const seen = (response: import("@playwright/test").Response): void => {
    if (
      response.request().method() === "POST" &&
      /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(response.url()).pathname)
    ) {
      void response
        .json()
        .then((body: unknown) => {
          const record = body as { runId?: unknown; duplicate?: unknown };
          if (typeof record.runId === "string") {
            responses.push({ runId: record.runId, duplicate: record.duplicate === true });
          }
        })
        .catch(() => undefined);
    }
  };
  pageC.on("response", seen);
  await pageC.getByRole("button", { name: /^Run$/ }).click();
  const runDialog = pageC.getByRole("dialog", { name: /run workflow/i });
  await runDialog.waitFor({ state: "visible" });
  await runDialog.getByRole("button", { name: /review and run/i }).click();
  const start = runDialog.getByRole("button", { name: /start run/i });
  const requestBodies: Array<Record<string, unknown>> = [];
  const onRequest = (request: import("@playwright/test").Request): void => {
    if (
      request.method() === "POST" &&
      /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(request.url()).pathname)
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      requestBodies.push(body);
    }
  };
  pageC.on("request", onRequest);
  await start.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await pageC.getByTestId("run-page").waitFor({ state: "visible", timeout: 30_000 });
  await sleep(800);
  pageC.off("response", seen);
  pageC.off("request", onRequest);
  const match = /\/r\/([^/?#]+)/u.exec(pageC.url());
  assert.ok(match?.[1] !== undefined);
  const runId = decodeURIComponent(match[1]);
  const latestDoc = await getWorkflow(http, projectId, workflowId);
  assert.ok(requestBodies.length >= 1, "run request must have been sent");
  for (const body of requestBodies) {
    assert.equal(body.etag, latestDoc.etag, "Run must use the freshest saved ETag");
    assert.equal(body.script, undefined);
  }
  const run = await getRun(http, runId);
  const snapshot = run.raw.snapshot as WorkflowDocument["workflow"] | undefined;
  const snapshotPrompt = snapshot?.graph.nodes.find((node) => node.type === "agent")?.prompt;
  assert.equal(snapshotPrompt, "Run latest prompt", "run must snapshot the latest save");
  assert.equal(
    await runCount(http, projectId, workflowId),
    beforeInvalidRun + 1,
    "double-click must create one run",
  );
  const ids = new Set(responses.map((item) => item.runId));
  assert.equal(ids.size, 1, "all idempotent responses must point at one run");
  const doubleClickOneRun = true;
  const duplicateResponses = responses.filter((item) => item.duplicate).length;
  await pageC.close();

  return {
    workflowId,
    twoPageConflict,
    reloadDiscardedLocal,
    overwriteUsedFreshEtag,
    externalEditConflict,
    inFlightKeptLatest,
    invalidBufferBlockedRun,
    runUsedFreshSave: true,
    runId,
    doubleClickOneRun,
    duplicateResponses,
  };
}
