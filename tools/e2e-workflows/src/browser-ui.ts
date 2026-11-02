import assert from "node:assert/strict";
import { type BrowserContext, chromium, type Page, type Request } from "@playwright/test";
import { chromiumPath } from "./chromium.js";
import type { Workspace } from "./fixtures.js";
import { sleep } from "./fixtures.js";
import type { DevChestraHttp } from "./http.js";
import { getWorkflow, saveWorkflow } from "./workflow-api.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export async function launchBrowser(
  ws: Workspace,
  options: { viewport?: { width: number; height: number }; colorScheme?: "light" | "dark" } = {},
): Promise<BrowserSession> {
  const context = await chromium.launchPersistentContext(ws.profileDir, {
    headless: true,
    executablePath: chromiumPath(),
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? "light",
  });
  const keepAlive = await context.newPage();
  await keepAlive.goto("about:blank");
  return { context, page: keepAlive };
}

export async function bootstrapPage(
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

export async function waitForHome(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /add project/i }).first();
  try {
    await button.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    await page.reload({ waitUntil: "domcontentloaded" });
    await button.waitFor({ state: "visible", timeout: 20_000 });
  }
}

export async function registerProjectThroughUi(page: Page, projectPath: string): Promise<string> {
  await waitForHome(page);
  await page
    .getByRole("button", { name: /add project/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /add project/i });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  await dialog.getByLabel(/project path|folder path/i).fill(projectPath);
  await dialog
    .getByRole("button", { name: /register project|add project/i })
    .last()
    .click();
  await page.waitForFunction(
    (path) => document.body.textContent?.includes(path) ?? false,
    projectPath,
    { timeout: 20_000 },
  );
  const match = /\/p\/([^/?#]+)/u.exec(page.url());
  if (match?.[1] !== undefined) return decodeURIComponent(match[1]);
  const id = await page.evaluate(async () => {
    const response = await fetch("/api/bootstrap", { credentials: "same-origin" });
    const body = (await response.json()) as { projects?: Array<{ id?: string; path?: string }> };
    return body.projects?.find((project) => project.path !== undefined)?.id ?? null;
  });
  assert.ok(id !== null, "project registration did not produce a project id");
  return id;
}

export async function createBlankWorkflowThroughUi(
  page: Page,
  projectId: string,
  name: string,
  id?: string,
  templateName: "blank" | "linear" = "blank",
): Promise<string> {
  await page.goto(new URL(`/p/${encodeURIComponent(projectId)}/workflows`, page.url()).toString(), {
    waitUntil: "domcontentloaded",
  });
  await page.getByTestId("workflows-page").waitFor({ state: "visible", timeout: 20_000 });
  await page
    .getByRole("button", { name: /new workflow/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /new workflow/i });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  await dialog.getByLabel(/^name/i).fill(name);
  if (id !== undefined) {
    const idField = dialog.getByLabel(/workflow id/i);
    if (await idField.count()) await idField.fill(id);
  }
  const template = dialog.getByLabel(/template/i);
  if (await template.count()) {
    await template
      .selectOption(templateName)
      .catch(async () =>
        template.selectOption({ label: templateName === "blank" ? "Blank" : "Linear fake" }),
      );
  }
  await dialog.getByRole("button", { name: /create workflow/i }).click();
  await page.getByTestId("editor-page").waitFor({ state: "visible", timeout: 20_000 });
  const match = /\/p\/[^/]+\/w\/([^/?#]+)/u.exec(page.url());
  assert.ok(match?.[1] !== undefined, "new workflow did not navigate to the editor");
  return decodeURIComponent(match[1]);
}

export async function openEditor(page: Page, projectId: string, workflowId: string): Promise<void> {
  await page.goto(
    new URL(
      `/p/${encodeURIComponent(projectId)}/w/${encodeURIComponent(workflowId)}`,
      page.url(),
    ).toString(),
    { waitUntil: "domcontentloaded" },
  );
  await page.getByTestId("editor-page").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("editor-canvas").waitFor({ state: "visible", timeout: 20_000 });
}

export async function addNode(
  page: Page,
  type: "start" | "agent" | "shell" | "end",
): Promise<void> {
  await page.getByTestId(`palette-add-${type}`).click();
  await page.getByTestId(`ed-node-${type}`).waitFor({ state: "visible", timeout: 10_000 });
}

export async function fitView(page: Page): Promise<void> {
  const control = page.locator(".react-flow__controls-fitview").first();
  if (await control.count()) {
    await control.click();
    await sleep(180);
  }
}

export async function selectNode(page: Page, id: string): Promise<void> {
  await fitView(page);
  await page.getByTestId(`ed-node-${id}`).click();
  await page.waitForFunction(
    (nodeId) =>
      (document.querySelector('[data-testid="inspector-node-id"]') as HTMLInputElement | null)
        ?.value === nodeId,
    id,
    { timeout: 10_000 },
  );
}

export async function setAgentCliFake(
  http: DevChestraHttp,
  page: Page,
  projectId: string,
  workflowId: string,
  id: string,
): Promise<void> {
  // Fake is retired from the registry-driven dropdown, so tests set it via
  // the API (server enforces DEVCHESTRA_ALLOW_FAKE=1 at run) then reload the editor.
  await waitSaved(page);
  const doc = await getWorkflow(http, projectId, workflowId);
  const node = doc.workflow.graph.nodes.find((entry) => entry.id === id);
  assert.ok(node !== undefined, `workflow has no node ${id}`);
  (node as { cli?: string }).cli = "fake";
  await saveWorkflow(http, projectId, workflowId, doc.workflow, doc.etag);
  await openEditor(page, projectId, workflowId);
  await waitSaved(page);
  await selectNode(page, id);
}

export async function renameSelectedNode(page: Page, name: string): Promise<void> {
  const field = page.getByTestId("inspector-node-name");
  await field.fill(name);
  await field.blur();
}

export async function connectNodes(page: Page, from: string, to: string): Promise<void> {
  await fitView(page);
  const source = page.locator(`[data-id="${from}"] .ed-handle-out`).first();
  const target = page.locator(`[data-id="${to}"] .ed-handle-in`).first();
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const start = await source.boundingBox();
  const end = await target.boundingBox();
  assert.ok(start !== null, `source handle for ${from} is not visible`);
  assert.ok(end !== null, `target handle for ${to} is not visible`);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y, { steps: 4 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 18 });
  await page.mouse.up();
  await sleep(120);
}

export async function edgeCount(page: Page): Promise<number> {
  return page.locator(".react-flow__edge").count();
}

export async function dragNode(page: Page, id: string, dx: number, dy: number): Promise<void> {
  await fitView(page);
  const node = page.getByTestId(`ed-node-${id}`);
  const box = await node.boundingBox();
  assert.ok(box !== null, `node ${id} is not visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
  await sleep(120);
}

export async function waitSaved(page: Page, timeout = 20_000): Promise<void> {
  const status = page.getByTestId("autosave-status");
  await status.waitFor({ state: "attached", timeout });
  await page.waitForFunction(
    () => {
      const text =
        document
          .querySelector('[data-testid="autosave-status"]')
          ?.textContent?.trim()
          .toLowerCase() ?? "";
      return text === "saved";
    },
    undefined,
    { timeout },
  );
}

export async function waitValidation(
  page: Page,
  expected: "Valid" | "error",
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (target) => {
      const text =
        document.querySelector('[data-testid="validation-chip"]')?.textContent?.toLowerCase() ?? "";
      return target === "valid" ? text.includes("valid") : text.includes("error");
    },
    expected === "Valid" ? "valid" : "error",
    { timeout },
  );
}

export async function saveNow(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /^save$/i }).first();
  if (await button.count()) await button.click();
  await waitSaved(page);
}

export async function runFromEditor(
  page: Page,
  params: Record<string, string> = {},
  options: { doubleClick?: boolean } = {},
): Promise<{ runId: string; runRequest: Request | null; runUrl: string; responseStatus: number }> {
  let runRequest: Request | null = null;
  const listener = (request: Request): void => {
    if (
      request.method() === "POST" &&
      /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(request.url()).pathname)
    ) {
      runRequest = request;
    }
  };
  page.on("request", listener);
  try {
    await page.getByRole("button", { name: /^run$/i }).first().click();
    const dialog = page.getByRole("dialog", { name: /run workflow/i });
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    for (const [name, value] of Object.entries(params)) {
      const byTestId = dialog.getByTestId(`run-param-${name}`);
      const field = (await byTestId.count())
        ? byTestId
        : dialog.getByLabel(new RegExp(`^${name}`, "i"));
      if (await field.count()) await field.fill(value);
    }
    const review = dialog.getByRole("button", { name: /review and run|review/i });
    if (await review.count()) await review.click();
    const start = dialog.getByRole("button", { name: /start run|run workflow/i }).last();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/u.test(new URL(response.url()).pathname),
      { timeout: 60_000 },
    );
    if (options.doubleClick === true) {
      await start.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
    } else {
      await start.click();
    }
    const response = await responsePromise;
    await page.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
    const match = /\/p\/[^/]+\/r\/([^/?#]+)/u.exec(page.url());
    assert.ok(match?.[1] !== undefined, "run navigation has no run id");
    return {
      runId: decodeURIComponent(match[1]),
      runRequest,
      runUrl: page.url(),
      responseStatus: response.status(),
    };
  } finally {
    page.off("request", listener);
  }
}

export async function waitRunSucceeded(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const text =
        document.querySelector('[data-testid="run-status"]')?.textContent?.toLowerCase() ?? "";
      return text.includes("succeed") || text.includes("failed") || text.includes("rejected");
    },
    undefined,
    { timeout },
  );
  const text = (await page.getByTestId("run-status").textContent())?.trim().toLowerCase() ?? "";
  assert.ok(text.includes("succeed"), `run did not succeed: ${text}`);
}

export async function openRunDetail(page: Page, runUrl: string, path = "agent"): Promise<string> {
  await page.goto(runUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("run-page").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId(`run-node-${path}`).click();
  await page.getByTestId("detail-output").waitFor({ state: "attached", timeout: 20_000 });
  return (await page.getByTestId("detail-output").textContent()) ?? "";
}

export async function themeTo(page: Page, theme: "light" | "dark"): Promise<void> {
  const toggle = page.getByTestId("theme-toggle");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await page.evaluate(() => document.documentElement.dataset.theme);
    if (current === theme) return;
    await toggle.click();
    await sleep(120);
  }
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
}

export async function closeBrowser(session: BrowserSession): Promise<void> {
  await session.context.close().catch(() => undefined);
}
