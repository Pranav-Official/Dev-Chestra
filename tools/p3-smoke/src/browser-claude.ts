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

export interface ClaudeBrowserEvidence {
  projectId: string;
  workflowId: string;
  coldLoadGetOnly: boolean;
  coldLoadNoSpawn: boolean;
  loadButtonNormalClick: boolean;
  sourceClaudeSdk: boolean;
  dynamicModelsShown: boolean;
  exactValueNotResolved: boolean;
  noHardcodedAliases: boolean;
  fuzzyCasePunctuation: boolean;
  fuzzySubsequence: boolean;
  selectExactValue: boolean;
  saveReload: boolean;
  undoRedo: boolean;
  keyboardSelect: boolean;
  defaultClearsModel: boolean;
  customSelection: boolean;
  unknownSurvivesFailure: boolean;
  crossCliFenced: boolean;
  run202: boolean;
  exactModelOnArgv: boolean;
  noDiscoveryPromptOnRun: boolean;
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
  const list = page.getByTestId("inspector-agent-model-listbox");
  if (!(await list.isVisible().catch(() => false))) {
    await page.getByTestId("inspector-agent-model-trigger").click();
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

/** The id span is absent when the label already is the id, so fall back to the label. */
async function selectedId(page: Page): Promise<string> {
  const id = page.getByTestId("inspector-agent-model-selected-id");
  const source =
    (await id.count()) > 0 ? id : page.getByTestId("inspector-agent-model-selected-label");
  return ((await source.textContent()) ?? "").trim();
}

async function noModel(page: Page): Promise<boolean> {
  const value = await selectedId(page);
  return value === "" || /cli default|no model override/iu.test(value);
}

async function statusText(page: Page): Promise<string> {
  return ((await page.getByTestId("inspector-agent-model-status").textContent()) ?? "").trim();
}

async function statusTitle(page: Page): Promise<string> {
  return (await page.getByTestId("inspector-agent-model-status").getAttribute("title")) ?? "";
}

async function messageTitle(page: Page): Promise<string> {
  return (await page.getByTestId("inspector-agent-model-message").getAttribute("title")) ?? "";
}

async function bannerText(page: Page): Promise<string> {
  return ((await page.getByTestId("inspector-agent-model-message").textContent()) ?? "").trim();
}

async function waitBanner(page: Page, pattern: RegExp, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    (source) => {
      const text =
        document.querySelector('[data-testid="inspector-agent-model-message"]')?.textContent ?? "";
      return new RegExp(source, "i").test(text);
    },
    pattern.source,
    { timeout },
  );
}

async function waitFooter(page: Page, pattern: RegExp, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (source) => {
      const text =
        document.querySelector('[data-testid="inspector-agent-model-status"]')?.textContent ?? "";
      return new RegExp(source, "i").test(text);
    },
    pattern.source,
    { timeout },
  );
}

/** Either the catalog loaded (footer count) or a banner explains why it did not. */
async function waitSettled(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const footer =
        document.querySelector('[data-testid="inspector-agent-model-status"]')?.textContent ?? "";
      const banner = document.querySelector('[data-testid="inspector-agent-model-message"]');
      return !/Loading|Refreshing/.test(footer) && (banner !== null || /models?/.test(footer));
    },
    undefined,
    { timeout },
  );
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

async function optionIds(page: Page): Promise<string[]> {
  const ids = page.locator(
    '[data-testid^="inspector-agent-model-option-"] .model-picker-option-id',
  );
  const count = await ids.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(((await ids.nth(index).textContent()) ?? "").trim());
  }
  return values;
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
  await page.getByTestId(`inspector-agent-cli-${cli}`).click();
  await sleep(150);
}

async function setCustomModel(page: Page, model: string): Promise<void> {
  await openPicker(page);
  await page.getByTestId("inspector-agent-model-picker").fill(model);
  await page.getByTestId("inspector-agent-model-custom-option").click();
  await sleep(150);
}

async function axePicker(page: Page): Promise<{ serious: number; total: number }> {
  await injectAxe(page);
  const result = await page.evaluate(async () => {
    const container =
      document.querySelector('[data-testid="inspector-agent-model-popover"]') ??
      document.querySelector('[data-testid="inspector-agent-model-field"]');
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

export async function runClaudeBrowserScenario(): Promise<ClaudeBrowserEvidence> {
  const ws = await makeWorkspace("devchestra-p3-claude-browser-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  let context: BrowserContext | null = null;
  let standin: ModelStandin | null = null;
  const nonce = "b1";
  const baseId = `claude-qa-${nonce}`;
  const punctId = `claude-qa-${nonce}-punctuation.v2`;
  const unicodeId = `claude-qa-${nonce}-unicode-é`;
  try {
    standin = await installModelStandins(ws.root);
    const stub = standin;
    await stub.setControl({ claude: { nonce } });
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
      "Claude model discovery acceptance",
      "claude-discovery-picker",
    );
    for (const type of ["start", "agent", "end"] as const) await addNode(page, type);
    await fitView(page);
    await connectNodes(page, "start", "agent");
    await connectNodes(page, "agent", "end");
    await selectNode(page, "agent");
    await page
      .getByTestId("inspector-agent-prompt")
      .fill("Return the stand-in result for the Claude discovery acceptance run.");
    await setCli(page, "claude-code");
    await waitSaved(page);

    calls.length = 0;
    await stub.resetLog();
    await openPicker(page);
    await waitBanner(page, /couldn't load/i);
    const coldCalls = modelRequests(calls);
    const coldLoadGetOnly =
      coldCalls.every((call) => call.method === "GET") &&
      !coldCalls.some((call) => call.method === "POST");
    const coldLoadNoSpawn = (await stub.discoverySpawns("claude")).length === 0;
    assert.match(await bannerText(page), /couldn't load/iu);
    assert.match(await messageTitle(page), /No model catalog is cached yet/iu);
    assert.match(await statusTitle(page), /source: none/iu);
    assert.match(await statusText(page), /^0 models/u);
    assert.ok(await page.getByTestId("inspector-agent-model-default").isVisible());
    for (const id of ["inspector-agent-model-refresh", "inspector-agent-model-status"]) {
      assert.ok(await page.getByTestId(id).isVisible(), `${id} must stay visible while open`);
      await page.getByTestId(id).click({ trial: true, timeout: 5_000 });
    }
    const loadButton = page.getByTestId("inspector-agent-model-refresh");
    assert.equal(await loadButton.getAttribute("aria-label"), "Refresh models");

    calls.length = 0;
    await loadButton.click();
    await waitFooter(page, /\d+ models?/u);
    await stub.waitFor(
      "Claude discovery child",
      async () => ((await stub.discoverySpawns("claude")).length >= 1 ? true : null),
      20_000,
    );
    const loadCalls = modelRequests(calls);
    const loadButtonNormalClick =
      loadCalls.some((call) => call.method === "POST") &&
      loadCalls.every((call) => call.method === "POST" || call.method === "GET");
    const spawns = await stub.discoverySpawns("claude");
    assert.equal(spawns.length, 1);
    const frames = await stub.frames("claude");
    assert.ok(frames.length >= 1);
    assert.ok(
      frames.every(
        (frame) =>
          frame.type === "control_request" &&
          (frame.request as Record<string, unknown> | undefined)?.subtype === "initialize",
      ),
      "only initialize control frames may reach the Claude stand-in",
    );
    assert.equal(
      frames.some((frame) => JSON.stringify(frame).includes('"type":"user"')),
      false,
    );
    assert.deepEqual(await stub.violations("claude"), []);

    await openPicker(page);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="inspector-agent-model-option-"]').length >= 3,
      undefined,
      { timeout: 10_000 },
    );
    const sourceClaudeSdk = /claude-sdk/u.test(await statusTitle(page));
    assert.ok(sourceClaudeSdk, `source must be claude-sdk, got ${await statusTitle(page)}`);
    assert.match(await statusText(page), /\b3 models\b/u);
    const texts = await optionTexts(page);
    const ids = await optionIds(page);
    assert.deepEqual(ids, [baseId, punctId, unicodeId]);
    const dynamicModelsShown =
      texts.some((text) => text.includes(`QA Claude ${nonce}`)) &&
      texts.some((text) => text.includes("QA Punct")) &&
      texts.some((text) => text.includes("QA Unicode"));
    assert.ok(dynamicModelsShown, "dynamic SDK models must be displayed");
    const exactValueNotResolved = ids.includes(baseId) && !ids.includes(`resolved-${nonce}`);
    assert.ok(exactValueNotResolved, "resolvedModel must not replace ModelInfo.value");
    const noHardcodedAliases = !texts.some((text) =>
      /\b(sonnet|opus|haiku|fable|opusplan)\b/iu.test(text),
    );
    assert.ok(noHardcodedAliases, "no hardcoded vendor aliases may be fabricated");

    await typeQuery(page, "qa punct b1");
    const punctTexts = await optionTexts(page);
    const fuzzyPunct = punctTexts.some((text) =>
      text.includes(`claude-qa-${nonce}-punctuation.v2`),
    );
    await typeQuery(page, "PUNCT");
    const caseTexts = await optionTexts(page);
    const fuzzyCase = caseTexts.some((text) => text.includes("QA Punct"));
    await typeQuery(page, "clb1p");
    const subsequenceTexts = await optionTexts(page);
    const fuzzySubsequence = subsequenceTexts.some((text) =>
      text.includes(`claude-qa-${nonce}-punctuation.v2`),
    );
    const fuzzyCasePunctuation = fuzzyPunct && fuzzyCase;
    assert.ok(
      fuzzyCasePunctuation && fuzzySubsequence,
      JSON.stringify({
        fuzzyPunct,
        fuzzyCase,
        fuzzySubsequence,
        punctTexts,
        caseTexts,
        subsequenceTexts,
      }),
    );

    await typeQuery(page, "clb1p");
    await page
      .locator('[data-testid^="inspector-agent-model-option-"]')
      .filter({ hasText: punctId })
      .first()
      .click();
    await waitSaved(page);
    const selected = await agentModel(http, project.id, workflowId);
    const selectExactValue = selected === punctId;
    assert.ok(selectExactValue, `saved exact model was ${String(selected)}`);

    await page.getByRole("button", { name: "Undo" }).click();
    await sleep(150);
    const undone = await noModel(page);
    await page.getByRole("button", { name: "Redo" }).click();
    await sleep(150);
    const redone = (await selectedId(page)).includes(punctId);
    await waitSaved(page);
    await openEditor(page, project.id, workflowId);
    await waitSaved(page);
    await selectNode(page, "agent");
    const undoRedo = undone && redone;
    const saveReload = (await selectedId(page)).includes(punctId);
    assert.ok(undoRedo && saveReload, "save/reload/undo/redo must preserve the exact id");

    await openPicker(page);
    await typeQuery(page, "unicode");
    await page.getByTestId("inspector-agent-model-picker").press("Home");
    await page.getByTestId("inspector-agent-model-picker").press("ArrowDown");
    await page.getByTestId("inspector-agent-model-picker").press("Enter");
    await sleep(150);
    await waitSaved(page);
    const keyboardSelect = (await agentModel(http, project.id, workflowId)) === unicodeId;
    assert.ok(keyboardSelect, "keyboard selection must persist the exact id");

    await openPicker(page);
    await page.getByTestId("inspector-agent-model-default").click();
    await waitSaved(page);
    const defaultClearsModel = (await agentModel(http, project.id, workflowId)) === null;

    const custom = `claude-qa-custom-unknown-${String(Date.now())}`;
    await setCustomModel(page, custom);
    await waitSaved(page);
    const customSelection = (await agentModel(http, project.id, workflowId)) === custom;
    assert.ok(customSelection, "custom model id must be persisted exactly");

    await stub.setControl({ claude: { nonce, fail: "error" } });
    await openPicker(page);
    const failureResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/clis\/claude-code\/models\/refresh$/u.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await page.getByTestId("inspector-agent-model-refresh").click();
    const failureResponse = await failureResponsePromise;
    assert.equal(failureResponse.status(), 200);
    await sleep(200);
    const unknownSurvivesFailure =
      (await selectedId(page)) === custom &&
      (await agentModel(http, project.id, workflowId)) === custom;
    assert.ok(unknownSurvivesFailure, "saved unknown id must survive a failed refresh");
    await closePicker(page);
    await stub.setControl({ claude: { nonce } });

    await setCli(page, "codex");
    await waitSaved(page);
    await openPicker(page);
    await stub.resetControl();
    await page.getByTestId("inspector-agent-model-refresh").click();
    await stub.waitFor(
      "Codex refresh RPC",
      async () => ((await stub.rpcs("codex")).length >= 5 ? true : null),
      20_000,
    );
    await waitFooter(page, /\d+ models?/u);
    await closePicker(page);

    await stub.setControl({ claude: { nonce, delayMs: 900 } });
    await setCli(page, "claude-code");
    await waitSaved(page);
    await openPicker(page);
    await page.getByTestId("inspector-agent-model-refresh").click();
    await setCli(page, "codex");
    await sleep(2_500);
    await openPicker(page);
    await waitSettled(page);
    const fencedOptions = await optionTexts(page);
    const fencedIds = await optionIds(page);
    const crossCliFenced =
      !fencedOptions.some((text) => text.includes(`QA Claude ${nonce}`)) &&
      !fencedIds.some((id) => id.startsWith(`claude-qa-${nonce}`));
    assert.ok(crossCliFenced, "an older Claude request must not populate the Codex picker");
    await closePicker(page);

    await setCli(page, "claude-code");
    await waitSaved(page);
    await openPicker(page);
    await typeQuery(page, punctId);
    await page.getByTestId("inspector-agent-model-option-0").click();
    await waitSaved(page);
    assert.equal(await agentModel(http, project.id, workflowId), punctId);
    const discoveryBeforeRun = (await stub.discoverySpawns("claude")).length;
    const run = await runFromEditor(page, {});
    assert.equal(run.responseStatus, 202);
    await waitRunSucceeded(page, 90_000);
    const exec = await stub.waitFor(
      "Claude exec capture",
      async () => {
        const entries = await stub.execSpawns("claude");
        return entries.find((entry) => entry.mode === "exec") ?? null;
      },
      30_000,
    );
    const exactModelOnArgv = exec.model === punctId && (exec.argv ?? []).includes("--model");
    const noDiscoveryPromptOnRun =
      (exec.argv ?? []).every((arg) => !arg.includes("--input-format")) &&
      !(exec.stdin ?? "").includes("control_request") &&
      exec.forbiddenFrame !== true;
    const testHomePreserved =
      exec.home === stub.env.HOME && exec.claudeHome === stub.env.CLAUDE_CONFIG_DIR;
    const noDiscoveryDuringRun =
      (await stub.discoverySpawns("claude")).length === discoveryBeforeRun;
    assert.ok(exactModelOnArgv, "selected exact Claude id must reach --model");
    assert.ok(noDiscoveryPromptOnRun, "workflow mode must not carry the discovery protocol");
    assert.ok(noDiscoveryDuringRun, "a workflow run must not start SDK discovery");
    await stub.assertSentinelsUnchanged();

    const shots = join(
      REPO_ROOT,
      "tools/p3-smoke/artifacts",
      new Date().toISOString().replaceAll(":", "-"),
    );
    await mkdir(shots, { recursive: true });
    const light = join(shots, "claude-model-picker-light.png");
    const dark = join(shots, "claude-model-picker-dark.png");
    const narrow = join(shots, "claude-model-picker-narrow.png");
    const inspector = join(shots, "claude-model-picker-inspector.png");

    await openEditor(page, project.id, workflowId);
    await waitSaved(page);
    await themeTo(page, "light");
    await selectNode(page, "agent");
    await openPicker(page);
    const axeLight = await axePicker(page);
    await page.getByTestId("inspector-agent-model-popover").screenshot({ path: inspector });
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

    const evidence: ClaudeBrowserEvidence = {
      projectId: project.id,
      workflowId,
      coldLoadGetOnly,
      coldLoadNoSpawn,
      loadButtonNormalClick,
      sourceClaudeSdk,
      dynamicModelsShown,
      exactValueNotResolved,
      noHardcodedAliases,
      fuzzyCasePunctuation,
      fuzzySubsequence,
      selectExactValue,
      saveReload,
      undoRedo,
      keyboardSelect,
      defaultClearsModel,
      customSelection,
      unknownSurvivesFailure,
      crossCliFenced,
      run202: run.responseStatus === 202,
      exactModelOnArgv,
      noDiscoveryPromptOnRun,
      testHomePreserved,
      sentinelsUnchanged: true,
      axeSerious: { light: axeLight.serious, dark: axeDark.serious, narrow: axeNarrow.serious },
      axeTotal: { light: axeLight.total, dark: axeDark.total, narrow: axeNarrow.total },
      screenshots: { light, dark, narrow, inspector },
    };
    await writeFile(
      join(shots, "claude-model-discovery-evidence.json"),
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
