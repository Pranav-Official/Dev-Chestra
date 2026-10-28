import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";
import {
  addNode,
  bootstrapPage,
  connectNodes,
  createBlankWorkflowThroughUi,
  fitView,
  launchBrowser,
  openEditor,
  runFromEditor,
  selectNode,
  themeTo,
  waitRunSucceeded,
  waitSaved,
} from "./browser-ui.js";
import { injectAxe, seriousViolations } from "./chromium.js";
import { CLI, makeWorkspace, REPO_ROOT, sleep } from "./fixtures.js";
import { DevChestraHttp } from "./http.js";
import { installModelStandins, type ModelStandin } from "./model-standin.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import { collectSpawnedAgents } from "./store-read.js";
import { getWorkflow, registerProject } from "./workflow-api.js";

export interface ModelBrowserEvidence {
  projectId: string;
  workflowId: string;
  coldOpenGetOnly: boolean;
  coldOpenNoSpawn: boolean;
  typingNoMutation: boolean;
  escapeNoCommit: boolean;
  refreshPostOnly: boolean;
  metadataRpcOnly: boolean;
  noClaudeSpawn: boolean;
  paginationCount: number;
  fuzzyCasePunctuation: boolean;
  fuzzySubsequence: boolean;
  defaultClearsModel: boolean;
  customSelection: boolean;
  keyboardSelect: boolean;
  saveReload: boolean;
  undoRedo: boolean;
  cliChangeOneUndo: boolean;
  crossCliFenced: boolean;
  unknownSurvivesFailure: boolean;
  boundedFailureMs: number;
  pickerKeysDoNotDelete: boolean;
  run202: boolean;
  exactModelOnArgv: boolean;
  testHomePreserved: boolean;
  sentinelsUnchanged: boolean;
  axeSerious: { light: number; dark: number; narrow: number };
  axeTotal: { light: number; dark: number; narrow: number };
  screenshots: { light: string; dark: string; narrow: string; inspector: string };
}

interface ApiCall {
  method: string;
  path: string;
}

function modelRequests(calls: ApiCall[]): ApiCall[] {
  return calls.filter((call) =>
    /\/clis\/(codex|claude-code)\/models(\/refresh)?$/u.test(call.path),
  );
}

async function openPicker(page: Page): Promise<void> {
  const combo = page.getByTestId("inspector-agent-model-picker");
  await combo.click();
  const list = page.getByTestId("inspector-agent-model-listbox");
  if (!(await list.isVisible().catch(() => false))) {
    await combo.press("ArrowDown");
  }
  await list.waitFor({ state: "visible", timeout: 10_000 });
}

async function closePicker(page: Page): Promise<void> {
  await page.getByTestId("inspector-agent-model-picker").press("Escape");
  await page
    .getByTestId("inspector-agent-model-listbox")
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => undefined);
}

async function selectedId(page: Page): Promise<string> {
  return ((await page.getByTestId("inspector-agent-model-selected-id").textContent()) ?? "").trim();
}

async function assertReachable(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click({ trial: true, timeout: 5_000 });
}

async function noModel(page: Page): Promise<boolean> {
  const value = await selectedId(page);
  return value === "" || /cli default|no model override/iu.test(value);
}

async function statusText(page: Page): Promise<string> {
  return ((await page.getByTestId("inspector-agent-model-status").textContent()) ?? "").trim();
}

async function optionTexts(page: Page): Promise<string[]> {
  const options = page.locator('[data-testid^="inspector-agent-model-option-"]');
  const count = await options.count();
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    texts.push(((await options.nth(index).textContent()) ?? "").trim());
  }
  return texts;
}

async function typeQuery(page: Page, query: string): Promise<void> {
  await page.getByTestId("inspector-agent-model-picker").fill(query);
  await sleep(120);
}

async function agentModel(
  http: DevChestraHttp,
  projectId: string,
  workflowId: string,
): Promise<string | null> {
  const document = await getWorkflow(http, projectId, workflowId);
  const node = document.workflow.graph.nodes.find((entry) => entry.id === "agent");
  assert.ok(node !== undefined, "workflow has no agent node");
  const model = node.model;
  return typeof model === "string" ? model : null;
}

async function setCli(page: Page, cli: "codex" | "claude-code" | "fake"): Promise<void> {
  await page.getByTestId("inspector-agent-cli").selectOption(cli);
  await sleep(120);
}

async function setCustomModel(page: Page, model: string): Promise<void> {
  await openPicker(page);
  await page.getByTestId("inspector-agent-model-custom-input").fill(model);
  await page.getByTestId("inspector-agent-model-use-custom").click();
  await sleep(120);
}

async function axePicker(page: Page): Promise<{ serious: number; total: number }> {
  await injectAxe(page);
  const result = await page.evaluate(async () => {
    const container = document.querySelector('[data-testid="inspector-agent-model-field"]');
    const axe = (
      window as unknown as {
        axe?: { run: (root: unknown) => Promise<{ violations: unknown[] }> };
      }
    ).axe;
    if (axe === undefined || container === null) throw new Error("axe or picker missing");
    return (await axe.run(container)) as {
      violations: Array<{ id: string; impact: string | null; nodes: Array<{ target?: string[] }> }>;
    };
  });
  return { serious: seriousViolations(result).count, total: result.violations.length };
}

export async function runModelBrowserScenario(): Promise<ModelBrowserEvidence> {
  const ws = await makeWorkspace("devchestra-p3-models-browser-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  let context: BrowserContext | null = null;
  let standin: ModelStandin | null = null;
  try {
    standin = await installModelStandins(ws.root);
    const stub = standin;
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      env: stub.env,
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);

    const session = await launchBrowser(ws);
    context = session.context;
    const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
    const calls: ApiCall[] = [];
    page.on("request", (request: Request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("/clis/")) calls.push({ method: request.method(), path });
    });
    const workflowId = await createBlankWorkflowThroughUi(
      page,
      project.id,
      "Model selector acceptance",
      "model-picker",
    );
    for (const type of ["start", "agent", "end"] as const) await addNode(page, type);
    await fitView(page);
    await connectNodes(page, "start", "agent");
    await connectNodes(page, "agent", "end");
    await selectNode(page, "agent");
    await page
      .getByTestId("inspector-agent-prompt")
      .fill("Return the stand-in result for the model selector acceptance run.");
    await setCli(page, "codex");
    await waitSaved(page);

    calls.length = 0;
    await stub.resetLog();
    await openPicker(page);
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector('[data-testid="inspector-agent-model-status"]')?.textContent ?? "";
        return /unavailable|unsupported|stale|error/i.test(text);
      },
      undefined,
      { timeout: 10_000 },
    );
    const coldCalls = modelRequests(calls);
    const coldOpenGetOnly =
      coldCalls.every((call) => call.method === "GET") &&
      !coldCalls.some((call) => call.method === "POST");
    const coldOpenNoSpawn = (await stub.spawns()).length === 0;
    assert.match(await statusText(page), /unavailable|unsupported|not loaded/iu);
    assert.ok(await page.getByTestId("inspector-agent-model-default").isVisible());
    for (const id of [
      "inspector-agent-model-custom-input",
      "inspector-agent-model-refresh",
      "inspector-agent-model-status",
      "inspector-agent-model-source",
      "inspector-agent-model-count",
    ]) {
      assert.ok(await page.getByTestId(id).isVisible(), `${id} must stay visible while open`);
      await assertReachable(page, id);
    }
    await page.getByTestId("inspector-agent-model-custom-input").fill("probe");
    await assertReachable(page, "inspector-agent-model-use-custom");
    await page.getByTestId("inspector-agent-model-custom-input").fill("");

    const beforeTyping = await agentModel(http, project.id, workflowId);
    await typeQuery(page, "gpt61");
    const typingNoMutation =
      (await noModel(page)) && (await agentModel(http, project.id, workflowId)) === beforeTyping;
    await closePicker(page);
    const escapeNoCommit = await noModel(page);

    calls.length = 0;
    await openPicker(page);
    await page.getByTestId("inspector-agent-model-refresh").click();
    await stub.waitFor(
      "codex refresh RPC",
      async () => ((await stub.rpcs("codex")).length >= 5 ? true : null),
      20_000,
    );
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector('[data-testid="inspector-agent-model-status"]')?.textContent ?? "";
        return /ready/i.test(text);
      },
      undefined,
      { timeout: 20_000 },
    );
    await openPicker(page);
    const refreshCalls = modelRequests(calls);
    const refreshPostOnly =
      refreshCalls.some((call) => call.method === "POST") &&
      refreshCalls.every((call) => call.method === "POST" || call.method === "GET");
    const methods = (await stub.rpcs("codex")).map((entry) => entry.method ?? "");
    const metadataRpcOnly =
      methods.includes("initialize") &&
      methods.includes("initialized") &&
      methods.filter((method) => method === "model/list").length >= 2 &&
      methods.every((method) => !/^(thread|turn|account|config|session)\//u.test(method));
    const noClaudeSpawn = (await stub.spawns("claude")).length === 0;
    const countText = (
      (await page.getByTestId("inspector-agent-model-count").textContent()) ?? ""
    ).trim();
    const sourceText = (
      (await page.getByTestId("inspector-agent-model-source").textContent()) ?? ""
    ).trim();
    assert.match(countText, /6/u);
    assert.match(sourceText, /codex-app-server/iu);
    assert.ok((await optionTexts(page)).length >= 6);

    await typeQuery(page, "terra");
    const fuzzyTerra = (await optionTexts(page))[0]?.includes("Terra 6.1") ?? false;
    await typeQuery(page, "gpt61");
    const fuzzyPunct = (await optionTexts(page)).some((text) => text.includes("Terra 6.1"));
    await typeQuery(page, "rlypnc");
    const fuzzySubsequence = (await optionTexts(page)).some((text) =>
      text.includes("devchestra-punct.model/v2"),
    );
    await typeQuery(page, "beta exact");
    const fuzzyCase = (await optionTexts(page)).some((text) => text.includes("Beta-Exact"));
    const fuzzyCasePunctuation = fuzzyPunct && fuzzyCase;
    assert.ok(fuzzyTerra && fuzzyCasePunctuation && fuzzySubsequence, "fuzzy filtering failed");

    await typeQuery(page, "mini");
    await page.getByTestId("inspector-agent-model-picker").press("Home");
    await page.getByTestId("inspector-agent-model-picker").press("ArrowDown");
    await page.getByTestId("inspector-agent-model-picker").press("Enter");
    await sleep(150);
    const keyboardSelect = (await selectedId(page)).includes("o4-mini");
    assert.ok(keyboardSelect, `keyboard selection failed: ${await selectedId(page)}`);
    await waitSaved(page);
    const savedModel = await agentModel(http, project.id, workflowId);
    assert.equal(savedModel, "o4-mini");

    await page.getByRole("button", { name: "Undo" }).click();
    await sleep(150);
    const undone = await noModel(page);
    await page.getByRole("button", { name: "Redo" }).click();
    await sleep(150);
    const redone = (await selectedId(page)).includes("o4-mini");
    await waitSaved(page);
    await openEditor(page, project.id, workflowId);
    await waitSaved(page);
    await selectNode(page, "agent");
    const undoRedo = undone && redone;
    const saveReload = (await selectedId(page)).includes("o4-mini");

    await openPicker(page);
    await page.getByTestId("inspector-agent-model-default").click();
    await waitSaved(page);
    const defaultClearsModel = (await agentModel(http, project.id, workflowId)) === null;

    await setCustomModel(page, "custom-unknown-xyz");
    await waitSaved(page);
    const customSelection =
      (await agentModel(http, project.id, workflowId)) === "custom-unknown-xyz";

    await setCli(page, "claude-code");
    await waitSaved(page);
    const clearedOnCli = await noModel(page);
    await openPicker(page);
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector('[data-testid="inspector-agent-model-status"]')?.textContent ?? "";
        return /unsupported|unavailable|not supported/i.test(text);
      },
      undefined,
      { timeout: 10_000 },
    );
    const claudeStatus = await statusText(page);
    const claudeMessage =
      (await page.getByTestId("inspector-agent-model-message").textContent()) ?? "";
    const claudeOptions = await optionTexts(page);
    const claudeColdSpawn = (await stub.discoverySpawns("claude")).length === 0;
    await closePicker(page);
    const claudeColdUnavailable =
      /unavailable/iu.test(claudeStatus) &&
      /No model catalog is cached yet/u.test(claudeMessage) &&
      claudeColdSpawn &&
      !claudeOptions.some((text) => /sonnet|opus|haiku/iu.test(text));
    await page.getByRole("button", { name: "Undo" }).click();
    await page
      .waitForFunction(
        () => {
          const cli = (
            document.querySelector(
              '[data-testid="inspector-agent-cli"]',
            ) as HTMLSelectElement | null
          )?.value;
          const model =
            document.querySelector('[data-testid="inspector-agent-model-selected-id"]')
              ?.textContent ?? "";
          return cli === "codex" && model.includes("custom-unknown-xyz");
        },
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const cliAfterUndo = await page.getByTestId("inspector-agent-cli").inputValue();
    const modelAfterUndo = await selectedId(page);
    const cliChangeOneUndo =
      cliAfterUndo === "codex" &&
      modelAfterUndo.includes("custom-unknown-xyz") &&
      clearedOnCli &&
      claudeColdUnavailable;
    assert.ok(
      cliChangeOneUndo,
      JSON.stringify({ cliAfterUndo, modelAfterUndo, clearedOnCli, claudeStatus, claudeOptions }),
    );
    await page.getByRole("button", { name: "Redo" }).click();
    await sleep(150);
    await page.getByRole("button", { name: "Undo" }).click();
    await sleep(150);
    await waitSaved(page);

    await stub.setControl({ delayMs: 800 });
    calls.length = 0;
    await openPicker(page);
    await page.getByTestId("inspector-agent-model-refresh").click();
    await setCli(page, "claude-code");
    await sleep(2_500);
    await openPicker(page);
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector('[data-testid="inspector-agent-model-status"]')?.textContent ?? "";
        return /unavailable|unsupported|stale|error/i.test(text);
      },
      undefined,
      { timeout: 10_000 },
    );
    const fencedOptions = await optionTexts(page);
    const crossCliFenced =
      /unsupported|not supported|unavailable/iu.test(await statusText(page)) &&
      !fencedOptions.some((text) => /Alpha Exact|Terra 6.1|Mini Four/u.test(text));
    await stub.setControl({ delayMs: 0 });
    await setCli(page, "codex");
    await waitSaved(page);

    await setCustomModel(page, "custom-unknown-xyz");
    await waitSaved(page);
    await stub.setControl({ fail: "malformed" });
    await openPicker(page);
    const started = Date.now();
    const failureResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/clis\/codex\/models\/refresh$/u.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await page.getByTestId("inspector-agent-model-refresh").click();
    const failureResponse = await failureResponsePromise;
    const failureBody = (await failureResponse.json()) as { status?: string };
    const boundedFailureMs = Date.now() - started;
    assert.equal(failureResponse.status(), 200);
    assert.ok(
      failureBody.status === "stale" || failureBody.status === "unavailable",
      `unexpected failure status ${String(failureBody.status)}`,
    );
    const unknownSurvivesFailure =
      (await selectedId(page)).includes("custom-unknown-xyz") &&
      (await agentModel(http, project.id, workflowId)) === "custom-unknown-xyz";
    assert.ok(unknownSurvivesFailure, "saved custom id must survive a failed refresh");
    await stub.setControl({ fail: "none" });

    const nodeCountBefore = await page.locator(".react-flow__node").count();
    await page.getByTestId("inspector-agent-model-picker").focus();
    await page.getByTestId("inspector-agent-model-picker").press("Backspace");
    await page.getByTestId("inspector-agent-model-picker").press("Delete");
    await typeQuery(page, "gpt");
    await page.getByTestId("inspector-agent-model-picker").press("Delete");
    const nodeCountAfter = await page.locator(".react-flow__node").count();
    const pickerKeysDoNotDelete = nodeCountBefore === nodeCountAfter && nodeCountAfter >= 3;

    await closePicker(page);
    await setCustomModel(page, "exact-alpha");
    await waitSaved(page);
    assert.equal(await agentModel(http, project.id, workflowId), "exact-alpha");
    const run = await runFromEditor(page, {});
    assert.equal(run.responseStatus, 202);
    await waitRunSucceeded(page, 90_000);
    const exec = await stub.waitFor(
      "codex exec capture",
      async () => {
        const entries = await stub.execSpawns("codex");
        return entries.find((entry) => entry.mode === "exec") ?? null;
      },
      30_000,
    );
    const exactModelOnArgv = exec.model === "exact-alpha" && (exec.argv ?? []).includes("-m");
    const testHomePreserved = exec.home === stub.env.HOME && exec.codexHome === stub.env.CODEX_HOME;
    await stub.assertSentinelsUnchanged();

    const shots = join(
      REPO_ROOT,
      "tools/p3-smoke/artifacts",
      new Date().toISOString().replaceAll(":", "-"),
    );
    await mkdir(shots, { recursive: true });
    const light = join(shots, "model-picker-light.png");
    const dark = join(shots, "model-picker-dark.png");
    const narrow = join(shots, "model-picker-narrow.png");
    const inspector = join(shots, "model-picker-inspector.png");

    await openEditor(page, project.id, workflowId);
    await waitSaved(page);
    await themeTo(page, "light");
    await selectNode(page, "agent");
    await openPicker(page);
    const axeLight = await axePicker(page);
    await page.getByTestId("inspector-agent-model-field").screenshot({ path: inspector });
    await page.screenshot({ path: light, fullPage: true });

    await themeTo(page, "dark");
    await openPicker(page);
    const axeDark = await axePicker(page);
    await page.screenshot({ path: dark, fullPage: true });

    await page.setViewportSize({ width: 420, height: 900 });
    await openPicker(page);
    const axeNarrow = await axePicker(page);
    await page.screenshot({ path: narrow, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    assert.equal(axeLight.serious, 0, "axe serious/critical in light picker");
    assert.equal(axeDark.serious, 0, "axe serious/critical in dark picker");
    assert.equal(axeNarrow.serious, 0, "axe serious/critical in narrow picker");

    const evidence: ModelBrowserEvidence = {
      projectId: project.id,
      workflowId,
      coldOpenGetOnly,
      coldOpenNoSpawn,
      typingNoMutation,
      escapeNoCommit,
      refreshPostOnly,
      metadataRpcOnly,
      noClaudeSpawn,
      paginationCount: 6,
      fuzzyCasePunctuation,
      fuzzySubsequence,
      defaultClearsModel,
      customSelection,
      keyboardSelect,
      saveReload,
      undoRedo,
      cliChangeOneUndo,
      crossCliFenced,
      unknownSurvivesFailure,
      boundedFailureMs,
      pickerKeysDoNotDelete,
      run202: run.responseStatus === 202,
      exactModelOnArgv,
      testHomePreserved,
      sentinelsUnchanged: true,
      axeSerious: { light: axeLight.serious, dark: axeDark.serious, narrow: axeNarrow.serious },
      axeTotal: { light: axeLight.total, dark: axeDark.total, narrow: axeNarrow.total },
      screenshots: { light, dark, narrow, inspector },
    };
    await writeFile(
      join(shots, "model-selector-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    return evidence;
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    if (server !== null) {
      const agents = collectSpawnedAgents(ws.dataDir);
      await shutdownOwned({ server, agents, sentinel, keep: true, dataDir: ws.root });
      try {
        if (standin !== null) {
          await standin.assertNoLiveProcesses();
          await standin.assertSentinelsUnchanged();
        }
      } finally {
        await rm(ws.root, { recursive: true, force: true });
      }
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}
