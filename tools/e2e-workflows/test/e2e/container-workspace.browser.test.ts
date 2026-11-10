import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";
import { bootstrapPage, launchBrowser, openEditor } from "../../src/browser-ui.js";
import { makeWorkspace, scriptPath } from "../../src/fixtures.js";
import { DevChestraHttp } from "../../src/http.js";
import { cleanupTempRoots, makeRunWorkspaceRepo } from "../support/run-workspace-fixtures.js";
import { createManaged, withServer } from "../support/run-workspace-harness.js";

afterAll(cleanupTempRoots);
describe("container workspace selector", () => {
  it("shows container selection and tracked-change import at desktop and mobile sizes", async () => {
    const repo = makeRunWorkspaceRepo("dc-container-ui-");
    const ws = await makeWorkspace("dc-container-ui-data-");
    await withServer(
      { dataDir: ws.dataDir, projectRoot: repo.root, fakeScript: scriptPath("summary"), env: {} },
      async (server) => {
        const http = new DevChestraHttp(server.baseUrl);
        await http.health();
        await http.bootstrap(server.meta.token);
        const managed = await createManaged(http, repo.root, {
          schemaVersion: 1,
          id: "run-workspace",
          name: "Container UI",
          graph: {
            nodes: [
              { id: "start", name: "Start", type: "start", params: [] },
              { id: "shell", name: "Shell", type: "shell", command: "pwd", timeoutMin: 1 },
              { id: "end", name: "End", type: "end", status: "success", result: "{}" },
            ],
            edges: [
              { id: "a", from: "start", to: "shell" },
              { id: "b", from: "shell", to: "end" },
            ],
          },
        });
        const session = await launchBrowser(ws, { viewport: { width: 1440, height: 1000 } });
        try {
          const page = await bootstrapPage(session.context, server.baseUrl, server.meta.token);
          await openEditor(page, managed.projectId, managed.workflowId);
          await page.getByRole("button", { name: /^run$/i }).first().click();
          const dialog = page.getByRole("dialog", { name: /run workflow/i });
          await dialog.getByTestId("run-workspace-mode-container").check();
          const dirty = dialog.getByRole("checkbox", {
            name: "Include uncommitted changes to tracked files",
          });
          await dirty.check();
          assert.equal(await dirty.isChecked(), true);
          await page.screenshot({
            path: "/tmp/devchestra-container-desktop.png",
            fullPage: true,
            animations: "disabled",
          });
          await page.setViewportSize({ width: 390, height: 844 });
          await dirty.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: "/tmp/devchestra-container-mobile.png",
            fullPage: true,
            animations: "disabled",
          });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
          );
          await dialog.getByRole("button", { name: /review and run|review/i }).click();
          await dialog.getByTestId("run-workspace-review").waitFor();
          assert.match(
            await dialog.getByTestId("run-workspace-review").innerText(),
            /isolated clone/,
          );
        } finally {
          await session.context.close();
        }
      },
    );
  }, 90_000);
});
