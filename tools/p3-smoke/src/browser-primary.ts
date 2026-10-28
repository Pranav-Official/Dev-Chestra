import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  addNode,
  connectNodes,
  createBlankWorkflowThroughUi,
  dragNode,
  edgeCount,
  fitView,
  openEditor,
  runFromEditor,
  saveNow,
  selectNode,
  setAgentCliFake,
  themeTo,
  waitRunSucceeded,
  waitSaved,
  waitValidation,
} from "./browser-ui.js";
import { axeRun, injectAxe, seriousViolations } from "./chromium.js";
import { REPO_ROOT, sleep } from "./fixtures.js";
import type { RelayHttp } from "./http.js";
import {
  getRun,
  getWorkflow,
  type WorkflowDocument,
  type WorkflowFileLike,
} from "./workflow-api.js";

export interface PrimaryEvidence {
  projectId: string;
  workflowId: string;
  reloadByteStable: boolean;
  layoutPersisted: boolean;
  promptConfigured: boolean;
  schemaEdited: boolean;
  duplicateRejected: boolean;
  cycleRejected: boolean;
  undoRedo: boolean;
  runId: string;
  run202: boolean;
  closeReopen: boolean;
  outputVisible: boolean;
  transcriptVisible: boolean;
  snapshotImmutable: boolean;
  incompleteSaved: boolean;
  incompleteFixedAndRan: boolean;
  axeSerious: { list: number; editor: number; run: number };
  axeViolations: {
    list: Array<{
      id: string;
      impact: string | null;
      nodes: number;
      targets: string[];
      summaries: string[];
    }>;
    editor: Array<{
      id: string;
      impact: string | null;
      nodes: number;
      targets: string[];
      summaries: string[];
    }>;
    run: Array<{
      id: string;
      impact: string | null;
      nodes: number;
      targets: string[];
      summaries: string[];
    }>;
  };
  screenshots: {
    editorLight: string;
    editorDark: string;
    editorNarrow: string;
    runLight: string;
    runDark: string;
    runNarrow: string;
  };
}

function artifactDir(): string {
  return join(
    REPO_ROOT,
    "tools/p3-smoke/artifacts",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
}

async function field(page: Page, testId: string): Promise<string> {
  return page.getByTestId(testId).inputValue();
}

async function waitEdges(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.querySelectorAll(".react-flow__edge").length === count,
    expected,
    { timeout: 10_000 },
  );
}

async function removeEdge(page: Page, edgeId: string): Promise<void> {
  const edge = page.getByTestId(`rf__edge-${edgeId}`);
  const before = await edgeCount(page);
  await edge.click({ force: true });
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-testid="rf__edge-${id}"]`)?.classList.contains("selected"),
    edgeId,
    { timeout: 10_000 },
  );
  await page.getByTestId("editor-canvas").focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".react-flow__edge").length === count,
    before - 1,
    { timeout: 10_000 },
  );
}

function agentNode(file: WorkflowFileLike): Record<string, unknown> {
  const node = file.graph.nodes.find((item) => item.type === "agent");
  assert.ok(node !== undefined, "workflow has no agent node");
  return node;
}

async function addFourNodes(page: Page): Promise<void> {
  for (const type of ["start", "agent", "shell", "end"] as const) {
    await addNode(page, type);
  }
}

async function configureLinear(
  page: Page,
): Promise<{ prompt: string; result: string; command: string }> {
  await selectNode(page, "start");
  await page.getByTestId("inspector-node-name").fill("Inputs");
  await page.getByTestId("inspector-add-param").click();
  await page.getByTestId("inspector-param-0-name").fill("topic");
  await page.getByTestId("inspector-param-0-required").check();

  await selectNode(page, "agent");
  await page.getByTestId("inspector-node-name").fill("Research");
  await page.getByTestId("inspector-output-mode-structured").click();
  await page.getByTestId("inspector-output-structured-note").waitFor({ state: "visible" });
  const prompt = "Summarize {{ start.topic }} with three concise points.";
  await page.getByTestId("inspector-agent-prompt").fill(prompt);
  await page.getByTestId("inspector-output-row-1-max-items").fill("7");
  assert.equal(await page.getByTestId("inspector-output-row-1-max-items").inputValue(), "7");
  await sleep(100);
  await page.getByTestId("inspector-output-view-json").click();
  const schemaText = (await page.locator("details.inspector-json-view pre").textContent()) ?? "";
  assert.match(
    schemaText,
    /"maxItems":\s*7/u,
    "row-editor maxItems edit must update the in-memory schema",
  );

  await selectNode(page, "shell");
  await page.getByTestId("inspector-node-name").fill("Render");
  const command = "printf '%s\\n' {{ agent.summary }}";
  await page.getByTestId("inspector-shell-command").fill(command);

  await selectNode(page, "end");
  await page.getByTestId("inspector-node-name").fill("Done");
  const result = '{"summary": agent.summary, "points": agent.points}';
  await page.getByTestId("inspector-end-result").fill(result);
  return { prompt, result, command };
}

export async function runPrimaryBrowserFlow(
  context: BrowserContext,
  page: Page,
  http: RelayHttp,
  projectId: string,
): Promise<PrimaryEvidence> {
  const shots = artifactDir();
  await mkdir(shots, { recursive: true });

  const workflowId = await createBlankWorkflowThroughUi(
    page,
    projectId,
    "Browser primary workflow",
    "browser-primary",
  );
  await addFourNodes(page);
  await setAgentCliFake(http, page, projectId, workflowId, "agent");
  await fitView(page);
  assert.equal(
    await page.getByTestId("palette-add-start").count(),
    0,
    "Start palette item hides after add",
  );
  assert.equal(
    await page.getByTestId("palette-add-end").count(),
    1,
    "End palette item stays available for multiple exclusive ends",
  );
  assert.equal(
    await page.getByTestId("palette-add-end").isVisible(),
    true,
    "End palette item remains visible and addable",
  );
  const configured = await configureLinear(page);

  await selectNode(page, "agent");
  await page.getByTestId("inspector-agent-prompt").fill("Semantic undo probe");
  await page.getByRole("button", { name: "Undo" }).click();
  const afterUndo = await field(page, "inspector-agent-prompt");
  assert.notEqual(afterUndo, "Semantic undo probe", "undo must revert the semantic edit");
  await page.getByRole("button", { name: "Redo" }).click();
  assert.equal(
    await field(page, "inspector-agent-prompt"),
    "Semantic undo probe",
    "redo must restore the edit",
  );
  await page.getByTestId("inspector-agent-prompt").fill(configured.prompt);
  const undoRedo = true;

  await dragNode(page, "agent", 48, 24);

  await connectNodes(page, "start", "agent");
  await waitEdges(page, 1);
  await connectNodes(page, "agent", "shell");
  await waitEdges(page, 2);
  await connectNodes(page, "shell", "end");
  await waitEdges(page, 3);

  await connectNodes(page, "agent", "shell");
  await waitEdges(page, 3);
  await page
    .getByText(/already has a connection|already exists/i)
    .first()
    .waitFor({ timeout: 5_000 });
  const duplicateRejected = true;

  await removeEdge(page, "e-start-agent");
  await removeEdge(page, "e-shell-end");
  await waitEdges(page, 1);
  await connectNodes(page, "shell", "agent");
  await waitEdges(page, 1);
  await page
    .getByText(/would create a cycle/i)
    .first()
    .waitFor({ timeout: 5_000 });
  const cycleRejected = true;
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await waitEdges(page, 3);

  await saveNow(page);
  await waitValidation(page, "Valid");
  const saved = await getWorkflow(http, projectId, workflowId);
  const savedAgent = agentNode(saved.workflow);
  const savedUi = savedAgent.ui as Record<string, unknown> | undefined;
  assert.ok(typeof savedUi?.x === "number", "agent layout must persist");
  assert.equal(savedAgent.prompt, configured.prompt);
  const savedProperties = ((savedAgent.output as Record<string, unknown>).properties ??
    {}) as Record<string, Record<string, unknown>>;
  assert.equal(
    savedProperties.points?.maxItems,
    7,
    `row-editor maxItems edit must persist: ${JSON.stringify(savedAgent.output)}`,
  );
  assert.equal(
    (savedProperties.points?.items as Record<string, unknown> | undefined)?.maxLength,
    500,
    "complex item keywords must survive",
  );

  await openEditor(page, projectId, workflowId);
  await waitSaved(page);
  const reloaded = await getWorkflow(http, projectId, workflowId);
  assert.equal(reloaded.text, saved.text, "save -> reload must be byte-stable");
  await selectNode(page, "agent");
  const reloadedPrompt = await field(page, "inspector-agent-prompt");
  const reloadedUi = agentNode(reloaded.workflow).ui as Record<string, unknown> | undefined;
  assert.equal(reloadedPrompt, configured.prompt);
  assert.deepEqual(reloadedUi, savedUi);
  await selectNode(page, "shell");
  assert.equal(await field(page, "inspector-shell-command"), configured.command);
  await selectNode(page, "end");
  assert.equal(await field(page, "inspector-end-result"), configured.result);

  const light = join(shots, "editor-light-1440x900.png");
  await page.screenshot({ path: light, fullPage: true });
  await themeTo(page, "dark");
  await sleep(150);
  const dark = join(shots, "editor-dark-1440x900.png");
  await page.screenshot({ path: dark, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(150);
  const narrow = join(shots, "editor-narrow-390x844.png");
  await page.screenshot({ path: narrow, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await themeTo(page, "light");

  await injectAxe(page);
  const editorAxe = seriousViolations(await axeRun(page));

  await waitValidation(page, "Valid");
  const run = await runFromEditor(page, { topic: "P3 browser acceptance" });
  assert.equal(run.responseStatus, 202, "managed run must start async with 202");
  const runBody = run.runRequest?.postDataJSON() as Record<string, unknown> | null;
  assert.ok(runBody !== null, "run request body was not captured");
  assert.equal(runBody.etag, reloaded.etag, "run must use the freshest saved ETag");
  assert.equal(runBody.script, undefined, "browser must not send a fake script");
  assert.equal(runBody.provider, undefined, "browser must not send provider opt-in");

  const runUrl = run.runUrl;
  const immediate = await getRun(http, run.runId);
  assert.ok(
    !["succeeded", "failed", "rejected", "cancelled"].includes(immediate.status),
    "slow fake run must still be active when navigation starts",
  );
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(runUrl, { waitUntil: "domcontentloaded" });
  await reopened.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
  const closeReopen = true;
  await waitRunSucceeded(reopened, 90_000);

  await reopened.getByTestId("run-node-agent").click();
  const output = (await reopened.getByTestId("detail-output").textContent()) ?? "";
  assert.ok(
    output.includes("P3 slow summary"),
    `viewer output missing fake summary: ${output.slice(0, 300)}`,
  );
  assert.ok(output.includes("points"), "viewer output must include the points field");
  await reopened.getByTestId("tab-transcript").click();
  await reopened.getByTestId("transcript-panel").waitFor({ state: "visible", timeout: 15_000 });
  const transcript = (await reopened.getByTestId("transcript-panel").textContent()) ?? "";
  const transcriptVisible = !transcript.toLowerCase().includes("unavailable");
  assert.ok(transcriptVisible, "completed fake agent transcript must be available");
  await reopened.getByTestId("tab-detail").click();

  const runLight = join(shots, "run-light-1440x900.png");
  await reopened.screenshot({ path: runLight, fullPage: true });
  await themeTo(reopened, "dark");
  await sleep(150);
  const runDark = join(shots, "run-dark-1440x900.png");
  await reopened.screenshot({ path: runDark, fullPage: true });
  await reopened.setViewportSize({ width: 390, height: 844 });
  await sleep(150);
  const runNarrow = join(shots, "run-narrow-390x844.png");
  await reopened.screenshot({ path: runNarrow, fullPage: true });
  await reopened.setViewportSize({ width: 1440, height: 900 });
  await themeTo(reopened, "light");
  await injectAxe(reopened);
  const runAxe = seriousViolations(await axeRun(reopened));

  await openEditor(reopened, projectId, workflowId);
  await selectNode(reopened, "agent");
  await reopened.getByTestId("inspector-agent-prompt").fill("Late edit after a completed run");
  await saveNow(reopened);
  const afterLateEdit = await getRun(http, run.runId);
  const snapshot = afterLateEdit.raw.snapshot as WorkflowFileLike | undefined;
  const snapshotPrompt = agentNode(snapshot as WorkflowFileLike).prompt;
  assert.equal(
    snapshotPrompt,
    configured.prompt,
    "a later edit must not mutate the past run snapshot",
  );
  const snapshotImmutable = true;

  await reopened.goto(
    new URL(`/p/${encodeURIComponent(projectId)}/workflows`, reopened.url()).toString(),
    { waitUntil: "domcontentloaded" },
  );
  await reopened.getByTestId("workflows-page").waitFor({ state: "visible" });
  await injectAxe(reopened);
  const listAxe = seriousViolations(await axeRun(reopened));

  const incompleteId = await createBlankWorkflowThroughUi(
    reopened,
    projectId,
    "Incomplete then fixed",
    "incomplete-browser",
  );
  await addFourNodes(reopened);
  await setAgentCliFake(http, reopened, projectId, incompleteId, "agent");
  await saveNow(reopened);
  const incomplete = await getWorkflow(http, projectId, incompleteId);
  assert.equal(incomplete.validation.ok, false, "incomplete graph draft must save with errors");
  await openEditor(reopened, projectId, incompleteId);
  await waitSaved(reopened);
  await waitValidation(reopened, "error");
  const chip = reopened.getByTestId("validation-chip");
  assert.match(
    (await chip.textContent()) ?? "",
    /error/i,
    "reloaded incomplete graph must show errors",
  );
  await chip.click();
  const issuesText = (await reopened.locator("#editor-issue-panel").textContent()) ?? "";
  assert.match(
    issuesText,
    /cannot reach|not reachable|outbound|inbound/i,
    "inline issues must be actionable",
  );
  await connectNodes(reopened, "start", "agent");
  await connectNodes(reopened, "agent", "shell");
  await connectNodes(reopened, "shell", "end");
  await saveNow(reopened);
  await waitValidation(reopened, "Valid");
  const fixed = await getWorkflow(http, projectId, incompleteId);
  assert.ok(fixed.validation.ok, "fixed graph must validate");
  await runFromEditor(reopened, {});
  await waitRunSucceeded(reopened, 90_000);
  const incompleteFixedAndRan = true;

  return {
    projectId,
    workflowId,
    reloadByteStable: true,
    layoutPersisted: true,
    promptConfigured: true,
    schemaEdited: true,
    duplicateRejected,
    cycleRejected,
    undoRedo,
    runId: run.runId,
    run202: run.responseStatus === 202,
    closeReopen,
    outputVisible: true,
    transcriptVisible,
    snapshotImmutable,
    incompleteSaved: true,
    incompleteFixedAndRan,
    axeSerious: {
      list: listAxe.count,
      editor: editorAxe.count,
      run: runAxe.count,
    },
    axeViolations: {
      list: listAxe.ids,
      editor: editorAxe.ids,
      run: runAxe.ids,
    },
    screenshots: {
      editorLight: light,
      editorDark: dark,
      editorNarrow: narrow,
      runLight,
      runDark,
      runNarrow,
    },
  };
}

export async function axeWorkflowsPage(page: Page): Promise<number> {
  await injectAxe(page);
  return seriousViolations(await axeRun(page)).count;
}

export type { WorkflowDocument };
