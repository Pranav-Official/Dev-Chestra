import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import {
  addNode,
  bootstrapPage,
  connectNodes,
  createBlankWorkflowThroughUi,
  fitView,
  launchBrowser,
  openEditor,
  registerProjectThroughUi,
  runFromEditor,
  saveNow,
  selectNode,
  setAgentCliFake,
  waitRunSucceeded,
  waitSaved,
  waitValidation,
} from "./browser-ui.js";
import { axeRun, injectAxe, seriousViolations } from "./chromium.js";
import { CLI, makeWorkspace, REPO_ROOT, scriptPath } from "./fixtures.js";
import { RelayHttp } from "./http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import { collectSpawnedAgents } from "./store-read.js";
import { getWorkflow, type WorkflowFileLike } from "./workflow-api.js";

export interface RawEvidence {
  workflowId: string;
  rawModeDefault: boolean;
  canonicalRawSchema: boolean;
  saveReloadStable: boolean;
  runId: string;
  run202: boolean;
  unknownRecordVisible: boolean;
  anyFieldSaved: boolean;
  rawAxeSerious: number;
  screenshot: string;
}

function agentOutput(workflow: WorkflowFileLike): Record<string, unknown> {
  const agent = workflow.graph.nodes.find((node) => node.type === "agent");
  assert.ok(agent !== undefined, "workflow has no agent node");
  const output = agent.output;
  assert.ok(typeof output === "object" && output !== null, "agent has no output schema");
  return output as Record<string, unknown>;
}

export async function runRawBrowserScenario(): Promise<RawEvidence> {
  const ws = await makeWorkspace("relay-p3-raw-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  let context: BrowserContext | null = null;
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("raw"),
    });
    const http = new RelayHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const session = await launchBrowser(ws);
    context = session.context;
    const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
    const projectId = await registerProjectThroughUi(page, ws.projectDir);
    const workflowId = await createBlankWorkflowThroughUi(
      page,
      projectId,
      "Raw browser workflow",
      "raw-browser",
    );
    for (const type of ["start", "agent", "end"] as const) await addNode(page, type);
    await setAgentCliFake(http, page, projectId, workflowId, "agent");
    await fitView(page);
    await selectNode(page, "agent");
    await page.getByTestId("inspector-node-name").fill("Raw Research");
    await page
      .getByTestId("inspector-agent-prompt")
      .fill("Return a repository record with nested metadata.");
    const rawModeDefault = await page.getByTestId("inspector-output-mode-raw").isChecked();
    assert.equal(rawModeDefault, true, "new Agent must default to Raw JSON object");
    await page.getByTestId("inspector-output-raw-note").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("inspector-output-mode-structured").isChecked(), false);

    await selectNode(page, "end");
    await page.getByTestId("inspector-end-result").fill('{"record": agent}');
    await connectNodes(page, "start", "agent");
    await connectNodes(page, "agent", "end");
    await saveNow(page);
    await waitValidation(page, "Valid");
    const saved = await getWorkflow(http, projectId, workflowId);
    const schema = agentOutput(saved.workflow);
    assert.deepEqual(schema, { type: "object", additionalProperties: true });
    assert.equal(
      Object.hasOwn(schema, "properties"),
      false,
      "raw schema must not inject properties",
    );
    const canonicalRawSchema = true;

    await openEditor(page, projectId, workflowId);
    await waitSaved(page);
    await selectNode(page, "agent");
    assert.equal(await page.getByTestId("inspector-output-mode-raw").isChecked(), true);
    await page.getByTestId("inspector-output-view-json").click();
    const schemaView = (await page.locator("details.inspector-json-view pre").textContent()) ?? "";
    assert.match(schemaView, /"additionalProperties":\s*true/u);
    const reloaded = await getWorkflow(http, projectId, workflowId);
    assert.equal(reloaded.text, saved.text, "raw workflow save -> reload must be byte-stable");
    const saveReloadStable = true;
    await injectAxe(page);
    const rawAxe = seriousViolations(await axeRun(page));
    assert.equal(rawAxe.count, 0, `raw editor axe: ${JSON.stringify(rawAxe.ids)}`);
    const shots = join(
      REPO_ROOT,
      "tools/p3-smoke/artifacts",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    await mkdir(shots, { recursive: true });
    const screenshot = join(shots, "raw-editor-1440x900.png");
    await page.screenshot({ path: screenshot, fullPage: true });

    const run = await runFromEditor(page, {});
    assert.equal(run.responseStatus, 202);
    await waitRunSucceeded(page, 90_000);
    await page.getByTestId("run-node-agent").click();
    const output = (await page.getByTestId("detail-output").textContent()) ?? "";
    assert.match(
      output,
      /RAW_P3_SENTINEL/u,
      `viewer output missing raw marker: ${output.slice(0, 300)}`,
    );
    assert.match(output, /acme\/processor/u);
    assert.match(output, /records/u);
    const unknownRecordVisible = true;

    await page.goto(
      new URL(`/p/${encodeURIComponent(projectId)}/workflows`, page.url()).toString(),
      { waitUntil: "domcontentloaded" },
    );
    await page.getByTestId("workflows-page").waitFor({ state: "visible" });
    const anyId = await createBlankWorkflowThroughUi(
      page,
      projectId,
      "Any field workflow",
      "any-field",
    );
    for (const type of ["start", "agent", "end"] as const) await addNode(page, type);
    await fitView(page);
    await connectNodes(page, "start", "agent");
    await connectNodes(page, "agent", "end");
    await page.waitForFunction(
      () => document.querySelectorAll(".react-flow__edge").length === 2,
      undefined,
      { timeout: 10_000 },
    );
    await selectNode(page, "agent");
    await page.getByTestId("inspector-output-mode-structured").click();
    await page.getByTestId("inspector-output-structured-note").waitFor({ state: "visible" });
    await page.getByTestId("inspector-output-row-0-type").selectOption("any");
    await sleep(100);
    await saveNow(page);
    try {
      await waitValidation(page, "Valid");
    } catch {
      const chip = (await page.getByTestId("validation-chip").textContent()) ?? "";
      throw new Error(`Any-field workflow did not validate: ${chip}`);
    }
    const anySaved = await getWorkflow(http, projectId, anyId);
    const anySchema = agentOutput(anySaved.workflow);
    const properties = anySchema.properties as Record<string, unknown>;
    assert.deepEqual(properties.summary, {}, "Any field must save as an empty schema");
    await openEditor(page, projectId, anyId);
    await waitSaved(page);
    await selectNode(page, "agent");
    const typeValues = await page
      .locator('[data-testid^="inspector-output-row-"][data-testid$="-type"]')
      .evaluateAll((elements) => elements.map((element) => (element as HTMLSelectElement).value));
    assert.ok(typeValues.includes("any"), "reloaded Any field must keep type Any");
    const anyFieldSaved = true;

    return {
      workflowId,
      rawModeDefault,
      canonicalRawSchema,
      saveReloadStable,
      runId: run.runId,
      run202: run.responseStatus === 202,
      unknownRecordVisible,
      anyFieldSaved,
      rawAxeSerious: rawAxe.count,
      screenshot,
    };
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    if (server !== null) {
      const agents = collectSpawnedAgents(ws.dataDir);
      await shutdownOwned({ server, agents, sentinel, keep: false, dataDir: ws.root });
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
