import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { project } from "@devchestra/core";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { defaultIdempotencyKey, registerProject, startRun, waitTerminal } from "./api-ops.js";
import { CLI, makeWorkspace, REPO_ROOT, scriptPath, sleep } from "./fixtures.js";
import { DevChestraHttp } from "./http.js";
import {
  collectAgent,
  type OwnedServer,
  shutdownOwned,
  startSentinel,
  startServer,
} from "./owned.js";
import { readStoreSnapshot } from "./store-read.js";

const require = createRequire(import.meta.url);

export interface BrowserEvidence {
  runId: string;
  screenshots: { light: string; dark: string; narrow: string };
  tabCloseReopen: boolean;
  themeKeyboard: boolean;
  reconnectBanner: boolean;
  replayMatched: boolean;
  backToLive: boolean;
  htmlEscaped: boolean;
  axeSerious: number;
  axeViolations: Array<{ id: string; impact: string | null; nodes: number }>;
  urlHadNoToken: boolean;
}

export function chromiumPath(): string {
  const configured = process.env.DEVCHESTRA_CHROMIUM_PATH;
  if (configured !== undefined && configured !== "") return configured;
  return "/usr/bin/chromium";
}

function artifactDir(): string {
  return join(
    REPO_ROOT,
    "tools/p2-smoke/artifacts",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
}

async function bootstrapPage(
  context: BrowserContext,
  baseUrl: string,
  token: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !window.location.search.includes("t="), undefined, {
    timeout: 15_000,
  });
  return page;
}

async function openRun(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
}

async function statusText(page: Page, testId: string): Promise<string> {
  return (await page.getByTestId(testId).textContent())?.trim().toLowerCase() ?? "";
}

async function injectAxe(page: Page): Promise<void> {
  const path = require.resolve("axe-core/axe.min.js");
  const source = await readFile(path, "utf8");
  // The app's CSP has no 'unsafe-inline'; page.evaluate runs through the
  // DevTools protocol instead of an injected <script> element.
  await page.evaluate(source);
}

interface AxeResult {
  violations: Array<{ id: string; impact: string | null; nodes: unknown[] }>;
}

async function axeRun(page: Page): Promise<AxeResult> {
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe?: { run: (root: Document) => Promise<AxeResult> } })
      .axe;
    if (axe === undefined) throw new Error("axe-core was not injected");
    return axe.run(document);
  });
}

export async function runBrowserScenario(): Promise<BrowserEvidence> {
  const browserPath = chromiumPath();
  assert.ok(
    existsSync(browserPath),
    `Chromium is required at ${browserPath} (DEVCHESTRA_CHROMIUM_PATH)`,
  );
  const ws = await makeWorkspace("devchestra-p2-browser-");
  const html = await makeWorkspace("devchestra-p2-html-");
  const sentinel = startSentinel();
  const htmlSentinel = startSentinel();
  let mainRunId: string | null = null;
  let htmlRunId: string | null = null;
  const agents = new Map<number, { pid: number; pidStart: string; binary: string }>();
  let server: OwnedServer | null = null;
  let htmlServer: OwnedServer | null = null;
  let context: BrowserContext | null = null;
  let htmlContext: BrowserContext | null = null;
  const shots = artifactDir();
  await mkdir(shots, { recursive: true });
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("browser"),
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const projectView = await registerProject(http, ws.projectDir);
    const started = await startRun(http, projectView.id, {
      workflowFile: ws.workflowFile,
      params: { topic: "browser" },
      idempotencyKey: defaultIdempotencyKey(),
    });
    mainRunId = started.runId;
    const runUrl = `${server.baseUrl}/p/${projectView.id}/r/${started.runId}?path=research&tab=detail`;
    context = await chromium.launchPersistentContext(join(ws.root, "profile"), {
      headless: true,
      executablePath: browserPath,
      viewport: { width: 1440, height: 900 },
      colorScheme: "light",
    });
    const keepAlive = await context.newPage();
    await keepAlive.goto("about:blank");
    const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
    const urlHadNoToken = !page.url().includes("t=");
    assert.ok(urlHadNoToken, "bootstrap URL must lose the token");
    await openRun(page, runUrl);
    assert.equal(await page.getByTestId("run-page").getAttribute("data-run-id"), started.runId);
    await page.getByTestId("run-node-status-research").waitFor({ state: "attached" });
    const running = await statusText(page, "run-node-status-research");
    assert.ok(
      running.includes("run") || running.includes("progress"),
      `expected running, got '${running}'`,
    );

    await page.close();
    await sleep(1_200);
    const reopened = await context.newPage();
    await openRun(reopened, runUrl);
    const afterReopen = await statusText(reopened, "run-node-status-research");
    const tabCloseReopen = afterReopen.includes("run") || afterReopen.includes("progress");
    assert.ok(tabCloseReopen, "tab close/reopen lost the live running view");
    assert.ok(
      !http.requests.some((request) => request.path.includes("/cancel")),
      "browser close must not cancel the run",
    );

    await waitTerminal(http, started.runId, 60_000);
    await reopened.getByTestId("run-status").waitFor({ state: "attached" });
    await reopened.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="run-status"]')
          ?.textContent?.toLowerCase()
          .includes("succe"),
      undefined,
      { timeout: 30_000 },
    );

    const light = join(shots, "run-light-1440x900.png");
    await reopened.screenshot({ path: light, fullPage: true });
    const themeToggle = reopened.getByTestId("theme-toggle");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const theme = await reopened.evaluate(() => document.documentElement.dataset.theme);
      if (theme === "dark") break;
      await themeToggle.click();
      await sleep(150);
    }
    assert.equal(
      await reopened.evaluate(() => document.documentElement.dataset.theme),
      "dark",
      "theme toggle must reach dark",
    );
    await sleep(200);
    const dark = join(shots, "run-dark-1440x900.png");
    await reopened.screenshot({ path: dark, fullPage: true });
    const themeKeyboard = await (async () => {
      await themeToggle.focus();
      const before = await reopened.evaluate(() => document.documentElement.dataset.themeMode);
      await reopened.keyboard.press("Enter");
      await sleep(150);
      const after = await reopened.evaluate(() => document.documentElement.dataset.themeMode);
      return before !== after;
    })();
    assert.ok(themeKeyboard, "theme toggle must work from the keyboard");
    await reopened.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    const narrow = join(shots, "run-narrow-390x844.png");
    await reopened.screenshot({ path: narrow, fullPage: true });
    await reopened.setViewportSize({ width: 1440, height: 900 });

    await reopened.locator("body").click({ position: { x: 5, y: 5 } });
    let focusVisible = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await reopened.keyboard.press("Tab");
      focusVisible = await reopened.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return false;
        return (
          element.matches(":focus-visible") &&
          (element.tagName === "BUTTON" ||
            element.tagName === "A" ||
            element.getAttribute("role") === "slider")
        );
      });
      if (focusVisible) break;
    }
    assert.ok(focusVisible, "keyboard Tab must expose a visible focus target");

    await injectAxe(reopened);
    const axe = await axeRun(reopened);
    const seriousViolations = axe.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    const axeSerious = seriousViolations.length;
    const axeViolations = seriousViolations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
    }));

    await context.setOffline(true);
    let reconnectBanner = false;
    try {
      await reopened
        .getByTestId("connection-banner")
        .waitFor({ state: "visible", timeout: 22_000 });
      reconnectBanner = true;
    } catch {
      reconnectBanner = false;
    }
    await context.setOffline(false);
    if (reconnectBanner) {
      await reopened.getByTestId("connection-banner").waitFor({ state: "hidden", timeout: 15_000 });
    }
    assert.ok(reconnectBanner, "offline network must show the reconnecting banner");

    const snapshot = readStoreSnapshot(ws.dataDir, started.runId);
    const researchStarted = snapshot.events.find(
      (event) => event.type === "node.attempt.started" && event.path === "research",
    );
    assert.ok(researchStarted !== undefined, "research attempt event is required for replay");
    const atId = researchStarted.id;
    const atView = project(snapshot.events.filter((event) => event.id <= atId));
    const expectedStatus = (atView.executions.research?.status ?? "pending").toLowerCase();
    await reopened.goto(`${runUrl}&at=${String(atId)}`, { waitUntil: "domcontentloaded" });
    await reopened.getByTestId("replay-banner").waitFor({ state: "visible", timeout: 15_000 });
    const banner = (await reopened.getByTestId("replay-banner").textContent())?.trim() ?? "";
    assert.match(banner, new RegExp(`Replaying event ${String(atId)} of \\d+`));
    const replayStatus = await statusText(reopened, "run-node-status-research");
    assert.ok(!replayStatus.includes("succe"), "replay must not show the latest succeeded status");
    assert.ok(
      replayStatus.includes(expectedStatus.slice(0, 6)) || expectedStatus.length === 0,
      `replay status '${replayStatus}' should match projection '${expectedStatus}'`,
    );
    const replayDetail = (await reopened.getByTestId("detail-panel").textContent()) ?? "";
    assert.ok(
      replayDetail.includes("unavailable in replay") ||
        !replayDetail.includes("P2 browser summary"),
      "replay detail must not show the latest output",
    );
    const replayMatched = banner.includes(`Replaying event ${String(atId)}`);
    await reopened.getByTestId("back-to-live").click();
    await reopened.waitForFunction(() => !window.location.search.includes("at="), undefined, {
      timeout: 15_000,
    });
    const liveStatus = await statusText(reopened, "run-node-status-research");
    const backToLive = liveStatus.includes("succe");
    await reopened.getByTestId("run-node-research").click();
    await reopened.getByTestId("detail-output").waitFor({ state: "attached", timeout: 15_000 });
    const liveDetail = (await reopened.getByTestId("detail-output").textContent()) ?? "";
    assert.ok(
      liveDetail.includes("P2 browser summary"),
      "back-to-live must show the latest output",
    );

    htmlServer = await startServer({
      cli: CLI,
      dataDir: html.dataDir,
      cwd: html.projectDir,
      fakeScript: scriptPath("html"),
    });
    const htmlHttp = new DevChestraHttp(htmlServer.baseUrl);
    await htmlHttp.health();
    await htmlHttp.bootstrap(htmlServer.meta.token);
    const htmlProject = await registerProject(htmlHttp, html.projectDir);
    const htmlRun = await startRun(htmlHttp, htmlProject.id, {
      workflowFile: html.workflowFile,
      params: { topic: "html" },
      idempotencyKey: defaultIdempotencyKey(),
    });
    htmlRunId = htmlRun.runId;
    await waitTerminal(htmlHttp, htmlRun.runId, 60_000);
    htmlContext = await chromium.launchPersistentContext(join(html.root, "profile"), {
      headless: true,
      executablePath: browserPath,
      viewport: { width: 1440, height: 900 },
    });
    const htmlPage = await bootstrapPage(htmlContext, htmlServer.baseUrl, htmlServer.meta.token);
    await openRun(
      htmlPage,
      `${htmlServer.baseUrl}/p/${htmlProject.id}/r/${htmlRun.runId}?path=research`,
    );
    await htmlPage.getByTestId("run-node-research").waitFor({ state: "visible", timeout: 20_000 });
    await htmlPage.getByTestId("run-node-research").click();
    await htmlPage.getByTestId("detail-output").waitFor({ state: "attached", timeout: 15_000 });
    const output = htmlPage.getByTestId("detail-output");
    const text = (await output.textContent()) ?? "";
    assert.ok(text.includes("P2_HTML_SENTINEL"), "HTML fixture text must be visible as text");
    assert.ok(text.includes("<img") && text.includes("<script"), "markup must render literally");
    assert.equal(await output.locator("img").count(), 0, "no img element may be injected");
    assert.equal(await output.locator("script").count(), 0, "no script element may be injected");
    assert.equal(
      await htmlPage.evaluate(
        () => (window as unknown as { __devchestraPwned?: unknown }).__devchestraPwned,
      ),
      undefined,
      "injected handler must not execute",
    );
    const htmlEscaped = true;

    for (const workspace of [ws, html]) {
      const runId = workspace === ws ? started.runId : htmlRun.runId;
      try {
        const state = readStoreSnapshot(workspace.dataDir, runId);
        for (const event of state.events) {
          const agent = collectAgent(event as unknown as { type?: string; payload?: unknown });
          if (agent !== null) agents.set(agent.pid, agent);
        }
      } catch {
        // Best effort.
      }
    }

    await context.close();
    context = null;
    await htmlContext.close();
    htmlContext = null;

    return {
      runId: started.runId,
      screenshots: { light, dark, narrow },
      tabCloseReopen,
      themeKeyboard,
      reconnectBanner,
      replayMatched,
      backToLive,
      htmlEscaped,
      axeSerious,
      axeViolations,
      urlHadNoToken,
    };
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    if (htmlContext !== null) await htmlContext.close().catch(() => undefined);
    for (const [workspace, runId] of [
      [ws, mainRunId],
      [html, htmlRunId],
    ] as const) {
      if (runId === null) continue;
      try {
        const state = readStoreSnapshot(workspace.dataDir, runId);
        for (const event of state.events) {
          const agent = collectAgent(event as unknown as { type?: string; payload?: unknown });
          if (agent !== null) agents.set(agent.pid, agent);
        }
      } catch {
        // The browser/API evidence above remains authoritative.
      }
    }
    if (htmlServer !== null) {
      await shutdownOwned({
        server: htmlServer,
        agents: [...agents.values()],
        sentinel: htmlSentinel,
        keep: false,
        dataDir: html.root,
      });
    } else {
      htmlSentinel.kill("SIGKILL");
    }
    if (server !== null) {
      await shutdownOwned({
        server,
        agents: [...agents.values()],
        sentinel,
        keep: false,
        dataDir: ws.root,
      });
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}
