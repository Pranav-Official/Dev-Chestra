import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect } from "@playwright/test";
import { it } from "vitest";
import { bootstrapPage, openEditor, registerProjectThroughUi } from "../../src/browser-ui.js";
import { chromiumPath } from "../../src/chromium.js";
import { CLI, REPO_ROOT } from "../../src/fixtures.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function workflow() {
  return {
    schemaVersion: 1,
    id: "loops",
    name: "Loops",
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [], ui: { x: 20, y: 100 } },
        {
          id: "refine",
          type: "loop",
          name: "Refine",
          mode: "repeatUntil",
          maxIterations: 3,
          initialState: "{}",
          nextState: "loop.state",
          result: '{"round":loop.iteration}',
          until: "result.round >= 2",
          output: { type: "object", additionalProperties: true },
          ui: { x: 280, y: 100 },
          body: {
            nodes: [
              { id: "start", type: "start", name: "Start round", params: [], ui: { x: 20, y: 80 } },
              {
                id: "done",
                type: "end",
                name: "Finish round",
                status: "success",
                result: "{}",
                ui: { x: 280, y: 80 },
              },
            ],
            edges: [{ id: "body-edge", from: "start", to: "done" }],
          },
        },
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: "refine",
          ui: { x: 540, y: 100 },
        },
      ],
      edges: [
        { id: "a", from: "start", to: "refine" },
        { id: "b", from: "refine", to: "end" },
      ],
    },
  };
}

async function metadata(
  server: ChildProcess,
  dataDir: string,
): Promise<{ port: number; token: string }> {
  const path = join(dataDir, "server.json");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error("Owned browser-test server exited before readiness");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    await delay(40);
  }
  throw new Error("Owned browser-test server did not become ready");
}

it("edits a loop body with Apply/Cancel, reloads it, and inspects completed rounds in Chrome", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "devchestra-loop-browser-")));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  const workflows = join(project, ".devchestra", "workflows");
  mkdirSync(workflows, { recursive: true });
  mkdirSync(dataDir);
  const file = join(workflows, "loops.json");
  writeFileSync(file, JSON.stringify(workflow()));
  const server = spawn(
    process.execPath,
    [CLI, "start", "--foreground", "--data-dir", dataDir, "--port", "0", "--no-open"],
    {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  let browser: Browser | undefined;
  try {
    const meta = await metadata(server, dataDir);
    browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await bootstrapPage(context, `http://127.0.0.1:${meta.port}`, meta.token);
    const exceptions: string[] = [];
    page.on("pageerror", (error) => exceptions.push(error.message));
    const projectId = await registerProjectThroughUi(page, project);
    await openEditor(page, projectId, "loops");
    await page.getByTestId("ed-node-refine").click();
    await page.getByTestId("loop-body-open").click();
    const dialog = page.getByTestId("loop-body-dialog");
    await expect(dialog).toBeVisible();
    const canvas = await page.getByTestId("loop-body-canvas").boundingBox();
    expect(canvas?.height).toBeGreaterThanOrEqual(320);
    expect(canvas?.width).toBeGreaterThan(300);
    await page.getByTestId("ed-node-done").click();
    await page.getByTestId("inspector-end-result").fill('{"temporary":true}');
    await expect(page.getByTestId("loop-body-apply")).toBeEnabled();
    await page.getByTestId("loop-body-cancel").click();
    await expect(dialog).not.toBeVisible();
    await page.getByTestId("loop-body-open").click();
    await page.getByTestId("ed-node-done").click();
    await expect(page.getByTestId("inspector-end-result")).toHaveValue("{}");
    await page.getByTestId("inspector-end-result").fill('{"saved":true}');
    await page.getByTestId("loop-body-apply").click();
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(() => {
        const saved = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof workflow>;
        const loop = saved.graph.nodes.find((node) => node.id === "refine");
        return loop?.body?.nodes.find((node) => node.id === "done")?.result;
      })
      .toBe('{"saved":true}');
    await page.reload();
    await page.getByTestId("ed-node-refine").click();
    await page.getByTestId("loop-body-open").click();
    await page.getByTestId("ed-node-done").click();
    await expect(page.getByTestId("inspector-end-result")).toHaveValue('{"saved":true}');
    await page.getByTestId("loop-body-cancel").click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const review = page.getByRole("button", { name: "Review and run" });
    if (await review.count()) await review.click();
    await page.getByRole("button", { name: "Start run" }).click();
    await page.waitForURL(/\/r\//, { timeout: 20000 });
    await expect(page.getByTestId("run-node-status-refine")).toHaveText("Succeeded", {
      timeout: 20000,
    });
    await page.getByTestId("run-node-refine").click();
    await expect(page.getByTestId("detail-loop-iteration")).toHaveText("iteration 2");
    await expect(page.getByTestId("detail-loop-round-1")).toBeVisible();
    await expect(page.getByTestId("detail-loop-round-2")).toBeVisible();
    expect(exceptions).toEqual([]);
  } finally {
    await browser?.close();
    try {
      execFileSync(process.execPath, [CLI, "stop", "--data-dir", dataDir], {
        timeout: 30000,
        stdio: "ignore",
        windowsHide: true,
      });
    } finally {
      if (server.exitCode === null)
        await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
      if (server.exitCode === null) server.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 120000);
