import assert from "node:assert/strict";
import type { BrowserContext, Page } from "@playwright/test";
import { type ConflictEvidence, runBrowserConflictFlow } from "./browser-conflicts.js";
import { type PrimaryEvidence, runPrimaryBrowserFlow } from "./browser-primary.js";
import {
  bootstrapPage,
  launchBrowser,
  openEditor,
  registerProjectThroughUi,
} from "./browser-ui.js";
import { CLI, makeWorkspace, scriptPath, sleep } from "./fixtures.js";
import { DevChestraHttp, header } from "./http.js";
import {
  collectAgent,
  type OwnedServer,
  type SpawnedAgent,
  shutdownOwned,
  startSentinel,
  startServer,
} from "./owned.js";
import { collectSpawnedAgents } from "./store-read.js";

export interface BrowserEvidence {
  projectId: string;
  urlHadNoToken: boolean;
  keyboardDialog: boolean;
  keyboardCanvas: boolean;
  strictCsp: boolean;
  noCancelOnTabClose: boolean;
  primary: PrimaryEvidence;
  conflicts: ConflictEvidence;
}

function cspStrict(headers: Record<string, string | string[] | undefined>): boolean {
  const csp = (headers["content-security-policy"] ?? "").toString();
  const nosniff = (headers["x-content-type-options"] ?? "").toString();
  const referrer = (headers["referrer-policy"] ?? "").toString();
  return (
    csp.includes("default-src 'self'") &&
    csp.includes("connect-src 'self'") &&
    csp.includes("frame-ancestors 'none'") &&
    !csp.includes("unsafe-eval") &&
    nosniff === "nosniff" &&
    referrer === "no-referrer"
  );
}

async function keyboardDialogCheck(page: Page): Promise<boolean> {
  await page
    .getByRole("button", { name: /add project/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /add project/i });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const focusInside = await page.evaluate(() => {
    const active = document.activeElement;
    const dialogElement = document.querySelector("dialog[open]");
    return active !== null && dialogElement?.contains(active) === true;
  });
  assert.ok(focusInside, "native dialog must receive focus");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

async function keyboardCanvasCheck(page: Page): Promise<boolean> {
  await page.getByTestId("editor-canvas").focus();
  await page.keyboard.press("Tab");
  await page.getByTestId("inspector-node-name").waitFor({ state: "visible", timeout: 10_000 });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  assert.equal(
    focused,
    "editor-canvas",
    "focus must remain on the canvas while keyboard-selecting",
  );
  return true;
}

async function collectAgents(server: OwnedServer, dataDir: string): Promise<SpawnedAgent[]> {
  const agents = new Map<number, SpawnedAgent>();
  try {
    for (const agent of collectSpawnedAgents(dataDir)) agents.set(agent.pid, agent);
  } catch {
    const http = new DevChestraHttp(server.baseUrl);
    await http.bootstrap(server.meta.token);
    const runs = await http.api("GET", "/api/runs?limit=100");
    const items = (runs.body as { items?: Array<{ id?: string }> }).items ?? [];
    for (const item of items) {
      if (typeof item.id !== "string") continue;
      const events = await http.api(
        "GET",
        `/api/runs/${encodeURIComponent(item.id)}/events?limit=500`,
      );
      const page = (events.body as { items?: unknown[] }).items ?? [];
      for (const event of page) {
        const agent = collectAgent(event as { type?: string; payload?: unknown });
        if (agent !== null) agents.set(agent.pid, agent);
      }
    }
  }
  return [...agents.values()];
}

export async function runBrowserScenario(): Promise<BrowserEvidence> {
  const ws = await makeWorkspace("devchestra-p3-browser-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const cancelRequests: string[] = [];
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("slow"),
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    const boot = await http.bootstrap(server.meta.token);
    assert.ok(!boot.html.includes(server.meta.token));
    assert.ok(!server.stdoutLines.join("\n").includes(server.meta.token));
    assert.ok(!server.stderr().includes(server.meta.token));

    const session = await launchBrowser(ws);
    context = session.context;
    context.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("/cancel")) cancelRequests.push(path);
    });
    page = await bootstrapPage(context, server.baseUrl, server.meta.token);
    page.on("console", (message) => {
      if (message.type() === "error") process.stderr.write(`browser console: ${message.text()}\n`);
    });
    page.on("pageerror", (error) => process.stderr.write(`browser pageerror: ${error.message}\n`));
    assert.ok(!page.url().includes("t="), "token must leave the browser URL");
    const keyboardDialog = await keyboardDialogCheck(page);
    const projectId = await registerProjectThroughUi(page, ws.projectDir);

    const authHeader = await http.api("GET", "/api/bootstrap");
    assert.equal(authHeader.status, 200);
    const strictCsp = cspStrict(authHeader.headers);
    assert.ok(strictCsp, "app context must receive the strict CSP and hardening headers");
    assert.ok(header(authHeader, "x-devchestra-api") !== null);

    const primary = await runPrimaryBrowserFlow(context, page, http, projectId);

    const seed = await bootstrapPage(context, server.baseUrl, server.meta.token);
    await openEditor(seed, projectId, primary.workflowId);
    const keyboardCanvas = await keyboardCanvasCheck(seed);
    await sleep(100);
    const conflicts = await runBrowserConflictFlow(context, seed, http, projectId);
    assert.equal(conflicts.twoPageConflict, true);
    assert.equal(conflicts.reloadDiscardedLocal, true);
    assert.equal(conflicts.overwriteUsedFreshEtag, true);
    assert.equal(conflicts.externalEditConflict, true);
    assert.equal(conflicts.inFlightKeptLatest, true);
    assert.equal(conflicts.invalidBufferBlockedRun, true);
    assert.equal(conflicts.runUsedFreshSave, true);
    assert.equal(conflicts.doubleClickOneRun, true);

    assert.equal(primary.axeSerious.list, 0, "axe serious/critical on workflow list");
    assert.equal(
      primary.axeSerious.editor,
      0,
      `axe serious/critical on editor: ${JSON.stringify(primary.axeViolations.editor)}`,
    );
    assert.equal(
      primary.axeSerious.run,
      0,
      `axe serious/critical on run view: ${JSON.stringify(primary.axeViolations.run)}`,
    );
    assert.equal(primary.run202, true);
    assert.equal(primary.closeReopen, true);
    assert.equal(primary.transcriptVisible, true);
    assert.equal(primary.snapshotImmutable, true);

    assert.deepEqual(cancelRequests, [], "closing/reopening a tab must not send cancel");
    return {
      projectId,
      urlHadNoToken: true,
      keyboardDialog,
      keyboardCanvas,
      strictCsp,
      noCancelOnTabClose: true,
      primary,
      conflicts,
    };
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    if (server !== null) {
      const agents = await collectAgents(server, ws.dataDir).catch(() => []);
      await shutdownOwned({
        server,
        agents,
        sentinel,
        keep: false,
        dataDir: ws.root,
      });
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}
