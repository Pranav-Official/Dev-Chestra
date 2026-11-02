import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";
import {
  bootstrapPage,
  createBlankWorkflowThroughUi,
  fitView,
  launchBrowser,
  registerProjectThroughUi,
  runFromEditor,
  saveNow,
  selectNode,
  setAgentCliFake,
  waitValidation,
} from "../../src/browser-ui.js";
import { CLI, REPO_ROOT } from "../../src/fixtures.js";
import { DevChestraHttp } from "../../src/http.js";
import { shutdownOwned, startSentinel, startServer } from "../../src/owned.js";
import { getWorkflow } from "../../src/workflow-api.js";
import {
  cleanupTempRoots,
  makeRunWorkspaceRepo,
  tempRoot,
} from "../support/run-workspace-fixtures.js";
import { readEventPage } from "../support/run-workspace-harness.js";

let preserveRoots = false;
afterEach((ctx) => {
  const s = (ctx as { task?: { result?: { state?: string } } }).task?.result?.state;
  if (s !== "pass") preserveRoots = true;
});
afterAll(() => {
  if (preserveRoots) {
    process.stderr.write("approval browser retained roots\n");
    return;
  }
  cleanupTempRoots();
});

import { connectAndAssert, raiseCleanup } from "./approval-helpers.js";

describe("approval browser — real UI+inbox (launch held until freeze)", () => {
  it("authors valid exclusive-end approval graph, runs, inbox pending, approve with note, replay", async () => {
    const repo = makeRunWorkspaceRepo("devchestra-p35-browser-");
    const work = tempRoot("devchestra-p35-browser-work-");
    const dataDir = join(work.dir, "data");
    const profileDir = join(work.dir, "profile");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const sentinel = startSentinel();
    let server: any = null;
    let context: any = null;
    let failure: unknown;
    try {
      server = await startServer({
        cli: CLI,
        dataDir,
        cwd: repo.root,
        fakeScript: join(
          REPO_ROOT,
          "tools/e2e-workflows/test/fixtures/approval/scripts/fake-approval.json",
        ),
        env: {
          HOME: repo.home,
          GIT_CONFIG_GLOBAL: join(repo.home, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      const http = new DevChestraHttp(server.baseUrl);
      await http.health();
      await http.bootstrap(server.meta.token);
      const { context: ctx, page: warm } = await launchBrowser({
        root: work.dir,
        projectDir: repo.root,
        dataDir,
        profileDir,
      } as unknown as import("../../src/fixtures.js").Workspace);
      await warm.close();
      context = ctx;
      const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
      page.on("console", (msg) => console.log(`browser console ${msg.type()}: ${msg.text()}`));
      const projectId = await registerProjectThroughUi(page, repo.root);
      const workflowId = await createBlankWorkflowThroughUi(page, projectId, "approval browser");
      const initialNodes = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="ed-node-"]')].map(
          (el) => el.getAttribute("data-testid")?.replace("ed-node-", "") ?? "",
        ),
      );
      if (!initialNodes.includes("start")) {
        await page.getByTestId("palette-add-start").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("palette-add-start").click();
        await page
          .locator('[data-testid="ed-node-start"]')
          .waitFor({ state: "visible", timeout: 15_000 });
      }
      await page.getByTestId("palette-add-approval").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("palette-add-approval").click();
      await page
        .locator('[data-testid="ed-approval-handles-approval"]')
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.getByTestId("palette-add-agent").click();
      await page
        .locator('[data-testid^="ed-node-agent"]')
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("palette-add-agent").click();
      await page
        .locator('[data-testid^="ed-node-agent"]')
        .nth(1)
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("palette-add-end").click();
      await page
        .locator('[data-testid^="ed-node-end"]')
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("palette-add-end").click();
      await page
        .locator('[data-testid^="ed-node-end"]')
        .nth(1)
        .waitFor({ state: "visible", timeout: 10_000 });
      await fitView(page);
      const approvalId = "approval";
      const ids = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="ed-node-"]')].map(
          (el) => el.getAttribute("data-testid")?.replace("ed-node-", "") ?? "",
        ),
      );
      const agentIds = ids.filter((id) => id.startsWith("agent"));
      const endIds = ids.filter((id) => id.startsWith("end"));
      assert.equal(agentIds.length, 2, `expected 2 agents, got ${ids.join(",")}`);
      assert.equal(endIds.length, 2, `expected 2 ends, got ${ids.join(",")}`);
      const [agentOk, agentAlt] = agentIds as [string, string];
      const [endOk, endAlt] = endIds as [string, string];
      await selectNode(page, approvalId);
      await page
        .getByTestId("inspector-approval-message")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByTestId("inspector-approval-message")
        .fill("Approve this step for {{ start.topic }}");
      await page.getByTestId("inspector-approval-message").blur();
      await page
        .getByTestId("inspector-approval-irreversible")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("inspector-approval-irreversible").check();
      assert.ok(await page.getByTestId("inspector-approval-irreversible").isChecked());
      await page
        .getByTestId("inspector-approval-criteria-add")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("inspector-approval-criteria-add").click();
      await page
        .getByTestId("inspector-approval-criteria-0")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("inspector-approval-criteria-0").fill("Check output");
      await page.getByTestId("inspector-approval-criteria-0").blur();
      await page
        .getByTestId("approval-criteria-help")
        .waitFor({ state: "visible", timeout: 10_000 });
      await selectNode(page, agentOk);
      await page
        .getByTestId("inspector-agent-prompt")
        .waitFor({ state: "visible", timeout: 10_000 });
      await setAgentCliFake(http, page, projectId, workflowId, agentOk);
      await page.getByTestId("inspector-agent-prompt").fill("ok for {{ start.topic }}");
      await page.getByTestId("inspector-agent-prompt").blur();
      await selectNode(page, agentAlt);
      await setAgentCliFake(http, page, projectId, workflowId, agentAlt);
      await page
        .getByTestId("inspector-agent-prompt")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("inspector-agent-prompt").fill("alt for {{ start.topic }}");
      await page.getByTestId("inspector-agent-prompt").blur();
      await connectAndAssert(
        page,
        http,
        projectId,
        workflowId,
        "ed-handle-start-out",
        `ed-handle-${approvalId}-in`,
        "start",
        approvalId,
        1,
      );
      await connectAndAssert(
        page,
        http,
        projectId,
        workflowId,
        `ed-handle-${approvalId}-out-approved`,
        `ed-handle-${agentOk}-in`,
        approvalId,
        agentOk,
        2,
      );
      await connectAndAssert(
        page,
        http,
        projectId,
        workflowId,
        `ed-handle-${approvalId}-out-rejected`,
        `ed-handle-${agentAlt}-in`,
        `${approvalId}.rejected`,
        agentAlt,
        3,
      );
      await connectAndAssert(
        page,
        http,
        projectId,
        workflowId,
        `ed-handle-${agentOk}-out`,
        `ed-handle-${endOk}-in`,
        agentOk,
        endOk,
        4,
      );
      await connectAndAssert(
        page,
        http,
        projectId,
        workflowId,
        `ed-handle-${agentAlt}-out`,
        `ed-handle-${endAlt}-in`,
        agentAlt,
        endAlt,
        5,
      );
      await saveNow(page);
      try {
        await waitValidation(page, "Valid");
      } catch (e) {
        const chip = await page
          .getByTestId("validation-chip")
          .textContent()
          .catch(() => "no chip");
        const issuesText = await page.evaluate(
          () => document.body.textContent?.slice(0, 4000) ?? "",
        );
        const savedDiag = await getWorkflow(http, projectId, workflowId);
        const diagNodes = (savedDiag.workflow.graph.nodes as Array<{ id: string }>)
          .map((n) => n.id)
          .join(",");
        const diagEdges = (savedDiag.workflow.graph.edges as Array<{ from: string; to: string }>)
          .map((ed) => `${ed.from}->${ed.to}`)
          .join(",");
        const domNodes = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="ed-node-"]')]
            .map((el) => el.getAttribute("data-testid")?.replace("ed-node-", "") ?? "")
            .join(","),
        );
        const domHandles = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="ed-handle-"]')]
            .map((el) => el.getAttribute("data-testid"))
            .join(","),
        );
        throw new Error(
          `waitValidation Valid failed: chip=${JSON.stringify(chip)} issuesText=${JSON.stringify(issuesText.slice(0, 800))} savedNodes=${diagNodes} savedEdges=${diagEdges} domNodes=${domNodes} domHandles=${domHandles} savedValidation=${JSON.stringify(savedDiag.validation.errors.slice(0, 5))}`,
          { cause: e },
        );
      }
      const saved = await getWorkflow(http, projectId, workflowId);
      assert.ok(
        saved.validation.ok,
        `saved must be valid: ${JSON.stringify(saved.validation.errors).slice(0, 800)}`,
      );
      const edges = saved.workflow.graph.edges as Array<{ from: string; to: string }>;
      assert.ok(
        edges.some((e) => e.from === approvalId && e.to === agentOk),
        "approved edge missing",
      );
      assert.ok(
        edges.some((e) => e.from === `${approvalId}.rejected` && e.to === agentAlt),
        "rejected edge missing",
      );
      assert.ok(
        edges.some((e) => e.from === agentOk && e.to === endOk),
        "agentOk->endOk missing",
      );
      assert.ok(
        edges.some((e) => e.from === agentAlt && e.to === endAlt),
        "agentAlt->endAlt missing",
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("editor-page").waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("editor-canvas").waitFor({ state: "visible", timeout: 20_000 });
      await fitView(page);
      await selectNode(page, approvalId);
      assert.equal(
        await page.getByTestId("inspector-approval-message").inputValue(),
        "Approve this step for {{ start.topic }}",
      );
      let run: { responseStatus: number; runId: string; runUrl: string };
      try {
        run = await runFromEditor(page, {});
      } catch (e) {
        const dialogText = await page
          .getByRole("dialog")
          .textContent()
          .catch(() => "no dialog");
        const bodyText = await page
          .evaluate(() => document.body.textContent?.slice(0, 3000) ?? "")
          .catch(() => "no body");
        const consoleLogs = await page.evaluate(
          () => (window as unknown as { _logs?: string[] })._logs?.join("\n") ?? "no logs",
        );
        throw new Error(
          `runFromEditor failed: dialog=${JSON.stringify(dialogText?.slice(0, 800))} bodySnippet=${JSON.stringify(bodyText.slice(0, 800))} console=${JSON.stringify(consoleLogs.slice(0, 800))}`,
          { cause: e },
        );
      }
      // Also capture POST response via http for diagnostics (runFromEditor already waited for POST)
      const _lastRunResponse = run as unknown as { responseStatus: number };
      assert.equal(run.responseStatus, 202, `POST /runs must be 202, got ${run.responseStatus}`);
      const runId = run.runId;
      await page.goto(`${run.runUrl}?path=${encodeURIComponent(approvalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByTestId("approval-request").waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("approval-pending").waitFor({ state: "visible", timeout: 10_000 });
      assert.match(
        (await page.getByTestId("approval-message").textContent()) ?? "",
        /Approve this step/,
      );
      await page.getByTestId("approval-criteria").waitFor({ state: "visible", timeout: 10_000 });
      await page.goto(new URL("/", page.url()).toString(), {
        waitUntil: "domcontentloaded",
      });
      await page.getByTestId("inbox-list").waitFor({ state: "visible", timeout: 15_000 });
      const inboxLink = page.getByTestId(`inbox-${runId}`);
      await inboxLink.waitFor({ state: "visible", timeout: 10_000 });
      const href = await inboxLink.locator("a").first().getAttribute("href");
      const expectedHref = `/p/${projectId}/r/${runId}?path=${encodeURIComponent(approvalId)}`;
      assert.equal(href, expectedHref, `inbox link href must be ${expectedHref}, got ${href}`);
      await page.goto(`${run.runUrl}?path=${encodeURIComponent(approvalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByTestId("approval-note").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("approval-note").fill("looks good");
      let resolveCalls = 0;
      page.on("request", (req) => {
        if (
          req.method() === "POST" &&
          req.url().includes(`/approvals/${encodeURIComponent(approvalId)}/resolve`)
        )
          resolveCalls += 1;
      });
      const approveBtn = page.getByTestId("approval-approve");
      await approveBtn.waitFor({ state: "visible", timeout: 10_000 });
      const box = await approveBtn.boundingBox();
      assert.ok(box, "approve button not visible for double-click");
      // Capture POST response via waitForResponse rather than relying on transient done
      const resolveResponsePromise = page
        .waitForResponse(
          (resp) =>
            resp.url().includes(`/approvals/${encodeURIComponent(approvalId)}/resolve`) &&
            resp.request().method() === "POST",
          { timeout: 10_000 },
        )
        .catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
      const resolveResponse = await resolveResponsePromise;
      if (resolveResponse) {
        const status = resolveResponse.status();
        const body = await resolveResponse.text().catch(() => "");
        assert.ok(
          [200, 202].includes(status),
          `POST resolve must be 200/202, got ${status} body ${body.slice(0, 800)}`,
        );
        if (status >= 400) {
          const errText = await page
            .getByTestId("approval-error")
            .textContent()
            .catch(() => "no error");
          throw new Error(
            `POST resolve failed ${status}: ${body.slice(0, 800)} approval-error: ${errText?.slice(0, 800)}`,
          );
        }
      }
      assert.equal(resolveCalls, 1, "double-click must send single resolve");
      // Do not require transient approval-done; require durable approval-resolved and exactly one request
      await page.getByTestId("approval-resolved").waitFor({ state: "visible", timeout: 15_000 });
      assert.match((await page.getByTestId("approval-resolved").textContent()) ?? "", /Approved/i);
      const ev = await readEventPage(http, runId);
      const requestedIdx = ev.events.findIndex(
        (e: { type: string; path: string }) =>
          e.type === "approval.requested" && e.path === approvalId,
      );
      assert.ok(requestedIdx >= 0, "approval.requested must exist");
      const waitingIdx = ev.events.findIndex(
        (e: { type: string; path: string; payload: unknown }, idx: number) =>
          idx > requestedIdx &&
          e.type === "node.state" &&
          e.path === approvalId &&
          (e.payload as { to?: string }).to === "waiting_approval",
      );
      assert.ok(
        waitingIdx >= 0,
        `must have node.state waiting_approval after requested for ${approvalId}`,
      );
      const waitingEvent = ev.events[waitingIdx] as unknown as { id: number };
      assert.ok(
        typeof waitingEvent.id === "number" && waitingEvent.id > 0,
        "waiting event must have positive id",
      );
      const requestedId = waitingEvent.id;
      await page.goto(`${run.runUrl}?at=${requestedId}&path=${encodeURIComponent(approvalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByTestId("approval-pending").waitFor({ state: "visible", timeout: 15_000 });
      await page
        .getByTestId("approval-replay-guard")
        .waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await page.getByTestId("approval-approve").isDisabled(), true);
      assert.equal(await page.getByTestId("approval-reject").isDisabled(), true);
      await page.getByTestId("upstream-replay-note").waitFor({ state: "visible", timeout: 10_000 });
      const resolvedIdx = ev.events.findIndex(
        (e: { type: string }) => e.type === "approval.resolved",
      );
      assert.ok(resolvedIdx >= 0, "approval.resolved must exist");
      const resolvedEvent = ev.events[resolvedIdx] as unknown as { id: number };
      assert.ok(
        typeof resolvedEvent.id === "number" && resolvedEvent.id > 0,
        "resolved event must have positive id",
      );
      const resolvedId = resolvedEvent.id;
      await page.goto(`${run.runUrl}?at=${resolvedId}&path=${encodeURIComponent(approvalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByTestId("approval-resolved").waitFor({ state: "visible", timeout: 15_000 });
      // At resolved, pending is gone and buttons are not rendered (or disabled) — assert no pending controls
      assert.equal(
        await page.getByTestId("approval-pending").count(),
        0,
        "pending should not be visible at resolved replay",
      );
      // Upstream replay note still visible for replay
      await page.getByTestId("upstream-replay-note").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("detail-panel").waitFor({ state: "attached", timeout: 10_000 });
    } catch (e) {
      failure = e;
    }
    const failures: unknown[] = [];
    if (context)
      try {
        await context.close();
      } catch (e) {
        failures.push(e);
      }
    if (server) {
      try {
        const { collectSpawnedAgents } = await import("../../src/store-read.js");
        const agents = collectSpawnedAgents(dataDir);
        await shutdownOwned({
          server,
          agents,
          sentinel,
          keep: failures.length > 0 || failure !== undefined,
          dataDir,
        });
      } catch (e) {
        failures.push(e);
      }
    } else if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
    raiseCleanup(failure, failures, "browser");
  }, 300_000);
});
